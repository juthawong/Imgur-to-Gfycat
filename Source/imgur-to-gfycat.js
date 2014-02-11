"use strict";

var request = window.superagent;
var gfyEndpoints = {
  transcode: 'http://upload.gfycat.com/transcode/',
  transcodeRelease: 'http://upload.gfycat.com/transcodeRelease/',
  status: 'http://gfycat.com/cajax/get/',
  checkURL: 'http://gfycat.com/cajax/checkUrl/',
  fetch: 'http://gfycat.com/fetch/',
  home: 'http://gfycat.com/'
};
var supportedSites = ['imgur.com', 'minus.com', 'photobucket.com', 'imagsy.com', 'giffer.co', 'gifsplosion.com', 
                      'gifs-planet.com', 'googleusercontent.com', 'instagram.com', 'flickr.com', 'imageshack.com', 
                      'twitpic.com', '4chan.com', 'picasa.com'];
var gifRegex = new RegExp(".*(" + supportedSites.join('|') + ")/.*\\.gif(?:\\?.*)?$");
var forEach = Array.prototype.forEach.call.bind(Array.prototype.forEach);
var slice = Array.prototype.slice.call.bind(Array.prototype.slice);

// Start.
(function init(){
  // Don't gfy direct links - our anchor transformation will take care of clicks from the browser,
  // but if e.g. a user goes straight to an imgur url, we should support that - let them right click
  // if they really want a gfy.
  if (isEligibleGif(window.location.href)) return;

  // Listen to page changes to find new gifs. Useful for catching RES actions and so on.
  attachMutationObservers();

  // Scan the page for current eligible gifs.
  scan();

  // Listen to messages coming from the background page letting us know the context menu
  // button (convert to gfy) has been clicked.
  addContextMenuListener();
})();

//
// Scanning
//

// Scan page for <img> and <a> tags to replace.
function scan(element){
  if (!element) element = document;
  // Allow elements, docs, and doc fragments. Others are ignored.
  if ([1, 9, 11].indexOf(element.nodeType) === -1 ) return;
  
  // Grab eligible items on the page.
  var imgs = element.getElementsByTagName('img');
  var anchors = element.querySelectorAll('a[href*=".gif"]');

  // If an actual anchor or img is passed in, just use that - no chance of
  // an anchor being nested in an anchor, or an img in an img so this is fine.
  if (element.nodeName === "A") anchors = [element];
  if (element.nodeName === "IMG") imgs = [element];

  // Don't pass functions directly, 'force' might get set
  forEach(imgs, function(img){replaceGif(img);});
  forEach(anchors, function(a){replaceAnchor(a);});
}

// Listen to the page to catch any new anchors or images to convert.
function attachMutationObservers(){
  var observer = new WebKitMutationObserver(function(mutations) {
    mutations.forEach(function(m){
      scan(m.target);
    });
  });
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: 'src', childList: true });
}

//
// Replacement
//

// Replacing a gif on the page is a little more complex. We need to send the fetch
// request to gfycat so it can create and convert the file. When it finishes, it will redirect
// to the gfycat link so we can embed into the page.
// If `force` is true, the gif will be replaced regardless of validation (imgur).
function replaceGif(imgNode, force){
  if (!isEligibleGif(imgNode.src) && !force) return;
  if (imgNode.dataset.gyffied){
    // If we've tried this via the context menu, let the user know something went wrong.
    if (force) displayGfycatError();
    return;
  }

  // don't re-run this (can happen due to mutation observers)
  imgNode.dataset.gyffied = true; 

  // If this contains a fetch url (RES creates images from anchors), remove it
  if (imgNode.src.indexOf(gfyEndpoints.fetch) !== -1){
    imgNode.src = imgNode.src.replace(gfyEndpoints.fetch, '');
  }

  var parent = imgNode.parentNode;
  imgNode.style.display = 'none'; // hide while we are waiting for gfycat

  // url, cb, errorCb
  getGfyUrl(imgNode.src, replaceGifWithGfy, revert, force);

  function replaceGifWithGfy(id){

    // Create gfy img tag, which will be picked up by their js.
    var gfyImg = document.createElement('img');
    gfyImg.setAttribute('class', 'gfyitem');
    gfyImg.dataset.id = id;
    gfyImg.dataset.gyffied = true;
    parent.appendChild(gfyImg);

    // RES
    handleRES(imgNode);

    // Fix anchor navigation
    preventRedirectOnGfyCtlClick(imgNode);

    // Update any anchors to the new gfy url. Replace those prepended with /fetch/ and without.
    [gfyEndpoints.fetch + imgNode.src, imgNode.src].forEach(function(src){
      var anchors = document.querySelectorAll('a[href="' + src + '"]');
      forEach(anchors, function(a){
        if (a.href === src) a.href = gfyEndpoints.home + id;
      });
    });

    runGfyCat();
  }

  function revert(err){
    // Just show the old gif.
    imgNode.style.display = '';
  }

  function displayGfycatError(){
    var fadeLength = 3000, fadeDelay = 2000;

    imgNode.insertAdjacentHTML('afterend', 
      '<div style="transition: opacity ' + (fadeLength / 1000) + 's">' + 
        '<span class="gfycatError" style="opacity: 1; background: #d9534f; color: white; padding: 4px; z-index: 99999;">' + 
          'Error loading from Gfycat. Displaying original image.' + 
        '</span>' + 
      '</div>');
    var errorMsg = imgNode.nextSibling;
    // Ghetto fade
    setTimeout(function(){
      errorMsg.style.opacity = 0;
      setTimeout(function(){
        errorMsg.parentNode.removeChild(errorMsg);
      }, fadeLength);
    }, fadeDelay);
  }
}

// Replace an anchor link with a link to gfycat's fetch endpoint.
function replaceAnchor(anchorNode){
  if (!isEligibleGif(anchorNode.href)) return;
  if (anchorNode.dataset.gyffied) return;
  if (anchorNode.href.indexOf(gfyEndpoints.fetch) !== -1) return;
  anchorNode.href = gfyEndpoints.fetch + anchorNode.href;
  anchorNode.dataset.gyffied = true;
}

//
// GfyCat interaction
//

// Run /transcodeRelease to get the gfyURL. If the gfy exists, it will immediately be returned
// and everybody's happy. Otherwise, we return an error which will replace the gif. The image will be transcoded
// in the background for the next user.
// If we've forced transcoding (context menu), use /transcode so that we get it the first time - it is safe
// to assume the user really wants a gfy right now.
function getGfyUrl(url, cb, errorCb, force){
  request.get((force ? gfyEndpoints.transcode : gfyEndpoints.transcodeRelease) + randomString())
    .query({fetchUrl: url})
    .end(function(err, res){
      if (err) return errorCb(err);
      if (res.body.gfyName) cb(res.body.gfyName);
      else errorCb(new Error('Transcode in progress'));
    });
}

// Embed gfycat into the page.
function embedGfyCat(){
  // Skip if this has already been done
  if (document.getElementById('gfycatjs')) return;

  // Create embed script
  var script = document.createElement('script');
  script.src = chrome.extension.getURL('gfyembed.js');
  script.id = 'gfycatjs';
  (document.body || document.head || document.documentElement).appendChild(script);
}

// Run gfycat's init() function, which will find all convertable images and convert them.
// Can't invoke this directly as it relies on jsonp, but will execute in this context
// if invoked here - jsonp callback will fail.
function runGfyCat(){
  embedGfyCat();
  var script = document.createElement('script');
  script.type = 'text/javascript';
  var script_innards = document.createTextNode("(" + initGfy.toString() + ")();");
  script.appendChild(script_innards);
  (document.body || document.head || document.documentElement).appendChild(script);

  // GfyCollection.init() will use document.getElementsByClassName to find gfyable objects
  function initGfy(){
    // Wait for it to exist on page before running
    var runGfyEmbedScript = function(){
      if (window.gfyCollection && window.gfyCollection.init){
        window.gfyCollection.init();
      } else {
        setTimeout(runGfyEmbedScript, 1);
      }
    };
    runGfyEmbedScript();
  }
}


//
// Page Tweaks & Fixes
//

// RES hacks
function handleRES(imgNode){
  var parent = imgNode.parentNode;
  // Remove the image from view replace with the gfycat stub so gfycat's js can handle it.
  // Important NOT to remove it so we don't break RES.
  imgNode.style.display = '';
  imgNode.dataset.originalStyles = imgNode.style.cssText;
  imgNode.style.cssText = 'display: none !important;';

  // Hide any RES placeholders nearby.
  var RESPlaceholders = parent.getElementsByClassName('RESImagePlaceholder');
  forEach(RESPlaceholders, function(placeholder){
    placeholder.style.cssText = 'display: none !important';
  });

  // RES detection
  if(!parent.classList.contains('madeVisible')) return;

  // Fix overflow
  parent.addEventListener('mouseover', addPadding);
  parent.addEventListener('mouseout', removePadding);
  parent.style.transition = 'padding 0.5s';

  // Upon a click of an RES gallery control, remove the gfy and reset the imgNode.
  var controls = matchParents(imgNode, '.entry').querySelector('.RESGalleryControls');
  controls && controls.addEventListener('click', function cleanup(e){
    e.currentTarget.removeEventListener('click', cleanup);
    cleanupGfy(imgNode);
  });
}

// Fix controls (surrounding anchor causes redirect)
function preventRedirectOnGfyCtlClick(imgNode){
  // Find any enclosing anchor tags
  getParents(imgNode).forEach(function(parent){
    if (parent.nodeName === "A") addCancelListener(parent);
  });

  // Cancel clicks if the target is a descendant of the ctrlbox
  function addCancelListener(el){
    el.addEventListener('click', function(e){
      var target = e.target;
      if (matchParents(target, '.gfyCtrlBox')) {
        e.preventDefault();
      }
    });
  }
}

// Clean up a gfy.
function cleanupGfy(imgNode){

  // Reset original image styles.
  imgNode.style.cssText = imgNode.dataset.originalStyles;
  delete imgNode.dataset.originalStyles;

  // Remove gfy.
  var gfy = imgNode.parentNode.querySelector('.gfyitem');
  if (gfy) {
    gfy.parentNode.removeChild(gfy);
  }

  // Re-add RESImagePlaceholder. Without it, the image has no size and the page will collapse around it.
  if (imgNode.classList.contains('RESImage')){
    forEach(imgNode.parentNode.getElementsByClassName('RESImagePlaceholder'), function(placeholder){
      placeholder.style.cssText = '';
    });
  }

  // Remove any leftovers
  imgNode.parentNode.style['padding-bottom'] = '0px';
  delete imgNode.dataset.gyffied;

  // Clean up event listeners
  imgNode.removeEventListener('click', cleanupGfy);
  imgNode.parentNode.removeEventListener('mouseover', addPadding);
  imgNode.parentNode.removeEventListener('mouseout', removePadding);
}

function addPadding(e){
  e.currentTarget.style['padding-bottom'] = '60px';
}

function removePadding(e){
  e.currentTarget.style['padding-bottom'] = '0px';
}

//
// Context Menu
//

// Listen to messages from background script. The context menu allows us to translate any 
// image to gfycat, regardless of extension or origin.
// Therefore we skip the check in replaceGif (force) and go ahead and feed it into gfycat's embed code.
function addContextMenuListener(){
  chrome.extension.onMessage.addListener(function (message, sender, callback) {
    if (message.convertToGfyWithURL) {
      var imgNodes = document.querySelectorAll('img[src="' + message.convertToGfyWithURL + '"]');
      for(var i = 0; i < imgNodes.length; i++){
        replaceGif(imgNodes[i], true /* force */);
      }
    }
  });
}


//
// UTILS
// 

function isEligibleGif(url){ return gifRegex.test(url); }

function randomString(){
  var c = '';
  var a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (var b = 0; b < 10; b++) {
      c += a.charAt(Math.floor(Math.random() * a.length));
  }
  return c;
}

// Get all parents of an element.
function getParents(el) {
    var parents = [];

    var parent = el;
    while (parent !== document) {
      parents.push(parent);
      parent = parent.parentNode;
    }
    return parents;
}

// Return first match in array of nodes for a selector.
function matchArray(arr, selector){
  for(var i = 0; i < arr.length; i++){
    if (elementMatches(arr[i], selector)) return arr[i];
  }
}

// Return first matching parent for a selector.
function matchParents(el, selector) {
  return matchArray(getParents(el), selector);
}

// Proxy to element.matchesSelector.
function elementMatches(el, selector){
  return (el.matchesSelector ? el.matchesSelector(selector) : el.webkitMatchesSelector(selector));
}
