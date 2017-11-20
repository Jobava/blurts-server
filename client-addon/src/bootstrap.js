/* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this file,
* You can obtain one at http://mozilla.org/MPL/2.0/. */

let {interfaces: Ci, utils: Cu, classes: Cc} = Components;

Cu.import("resource://gre/modules/Services.jsm");

const dump = Cu.reportError;

const XMLHttpRequest = Components.Constructor("@mozilla.org/xmlextras/xmlhttprequest;1");

const kBreachListURL = "https://stage.haveibeenpwned.com/api/v2/breaches";
const kDefaultAddUserURL = "http://localhost:6060/user/add";

function initSiteList() {
  let xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function() {
    if (this.readyState == 4 && this.status == 200) {
      let sites = JSON.parse(xhr.responseText);
      siteSet = new Set(sites.map(site => site.Domain));
      startObserving();
    }
  };
  xhr.open("GET", kBreachListURL, true);
  xhr.send();
}

var observerAdded = false;

var tpl = {
  onLocationChange: function(aBrowser, aWebProgress, aRequest, aLocation) {
    warnIfNeeded(aBrowser, aLocation.host);
  }
}

function startObserving() {
  EveryWindow.registerCallback(
    "breach-alerts",
    (win) => {
      win.gBrowser.addTabsProgressListener(tpl);
    },
    () => {}
  );
  observerAdded = true;
}

function stopObserving() {
  if (observerAdded) {
    EveryWindow.unregisterCallback("breach-alerts");
  }
}

var siteSet = new Set();
var warnedHostSet = new Set();

function warnIfNeeded(browser, host) {
  if (host.startsWith("www.")) {
    host = host.substring(4);
  }
  if (!warnedHostSet.has(host) && siteSet.has(host)) {
    browser.ownerDocument.defaultView.PopupNotifications.show(
      browser, "breach-alerts", "You visited hacked site " + host + "!",
      null, null, null, {persistent: true});

    let panel = browser.ownerDocument.defaultView.PopupNotifications.panel;
    panel.addEventListener("popupshown", function() {
      let doc = browser.ownerDocument;
      let n = doc.getElementById("breach-alerts-notification");
      let box = doc.getAnonymousElementByAttribute(n, "class", "popup-notification-body");
      let i = doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "textbox");
      i.setAttribute("placeholder", "Enter email address and press enter");
      i.addEventListener("keydown", function listener(aEvent) {
        if (aEvent.key != "Enter") {
          return;
        }

        let xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function() {
          if (this.readyState == 4 && this.status == 200) {
            doc.defaultView.alert("Breach alerts prototype: user successfully registered with server.");
          }
        };
        let addUserURL = Services.prefs.getCharPref("extensions.breachalerts.addUserURL", kDefaultAddUserURL);
        xhr.open("POST", addUserURL, true);
        xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
        xhr.send(JSON.stringify({ email: i.value }));
        i.removeEventListener("keydown", listener);
        i.remove();
      });
      box.appendChild(i);
    }, { once: true });
    warnedHostSet.add(host);
  }
}

function startup(aData, aReason) {
  initSiteList();
}

function shutdown(aData, aReason) {
  stopObserving();
}

function install(aData, aReason) {}
function uninstall(aData, aReason) {}

var EveryWindow = {
  _callbacks: new Map(),
  _initialized: false,

  registerCallback: function EW_registerCallback(id, init, uninit) {
    if (this._callbacks.has(id)) {
      return;
    }

    this._callForEveryWindow(init);
    this._callbacks.set(id, {id, init, uninit});

    if (!this._initialized) {
      Services.obs.addObserver(this._onOpenWindow.bind(this),
                               "browser-delayed-startup-finished");
      this._initialized = true;
    }
  },

  unregisterCallback: function EW_unregisterCallback(aId, aCallUninit = true) {
    if (!this._callbacks.has(aId)) {
      return;
    }

    if (aCallUninit) {
      this._callForEveryWindow(this._callbacks.get(aId).uninit);
    }

    this._callbacks.delete(aId);
  },

  _callForEveryWindow(aFunction) {
    let windowList = Services.wm.getEnumerator("navigator:browser");
    while (windowList.hasMoreElements()) {
      let win = windowList.getNext();
      win.delayedStartupPromise.then(() => { aFunction(win) });
    }
  },

  _onOpenWindow(aWindow) {
    for (let c of this._callbacks.values()) {
      c.init(aWindow);
    }

    aWindow.addEventListener("unload",
                             this._onWindowClosing.bind(this),
                             { once: true });
  },

  _onWindowClosing(aEvent) {
    let win = aEvent.target;
    for (let c of this._callbacks.values()) {
      c.uninit(win);
    }
  },
};