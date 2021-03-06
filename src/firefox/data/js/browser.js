// implements browser_base.js

Browser.init = function (script) {
	Browser._script = script;
	Browser.log('initializing', script);

	Browser.storage._init();

	if(script == 'main') {
		Browser._main_script();
		Browser.gui._init();
		Browser._install_update();
	}
};

// handle installation and upgrade
Browser._install_update = function(){

	var self = require("sdk/self");

	if(self.loadReason == "install") {
		Util.events.fire('browser.install');
	}
	else if(self.loadReason == "upgrade"){
		Util.events.fire('browser.update');
	}
}

Browser._main_script = function() {
	// refresh icon when a tab is activated
	//
	require('sdk/tabs').on('activate', function (tab) {
		Browser.gui.refreshIcon(tab.id);
	});

	// content script insertion
	// we insert two scripts
	// 1. our content.js and auxiliary .js files that do the main job
	// 2. the messaging module's code, needed for communication with the content script (see https://github.com/Rob--W/browser-action-jplib/blob/master/docs/messaging.md)
	//
	var array = require('sdk/util/array');
	var data = require("sdk/self").data;
	const { createMessageChannel, messageContentScriptFile } = require('messaging');

	Browser.workers = [];

	// executed when a worker is created, each worker corresponds to a page
	// we need to create communication channel, and to keep track of workers in Browser.workers to
	// allow for main -> page communication
	//
	function onWorkerAttach(worker) {
		worker.channel = createMessageChannel(this.contentScriptOptions, worker.port);
		worker.channel.onMessage.addListener(function(msg, sender, sendResponse) {
			// sender is always null, we set it to worker.tab.id
			return Browser.handleMessage(msg, worker.tab.id, sendResponse);
		});

		array.add(Browser.workers, worker);

		// pagehide: called when user moves away from the page (closes tab or moves back/forward). the worker is not
		// valid anymore so we need to remove it. We also call refreshIcon to remove the icon.
		//
		worker.on('pagehide', function() {
			array.remove(Browser.workers, this);

			Browser.gui.refreshIcon(this.tab.id);
		});

		// pageshow: called when page is shown, either the first time, or when navigating history (back/forward button)
		// When havigating history, an old (hidden) worker is reused instead of creating a new one. So we need to put it
		// back to Browser.workers
		//
		worker.on('pageshow', function() {
			array.add(Browser.workers, this);
		});
	}

	// all http[s] pages: insert content.js and messaging code
	//
	require("sdk/page-mod").PageMod({
		include: ['*'],
		attachTo: ["top", "frame"],
		contentScriptWhen: 'start', // TODO THIS IS TRICKY
		contentScriptFile: [messageContentScriptFile,
							data.url("js/util.js"),
							data.url("js/browser_base.js"),
							data.url("js/browser.js"),
							data.url("js/laplace.js"),
							data.url("js/content.js")],
		contentScriptOptions: {
			channelName: 'whatever you want',
			endAtPage: false		// false: communicate with the content script
		},
		onAttach: onWorkerAttach,
	});

	// options page: insert only messaging code
	//
	require("sdk/page-mod").PageMod({
		include: [data.url("*")],
		contentScriptWhen: 'start', // sets up comm. before running the page scripts
		contentScriptFile: [messageContentScriptFile],
		contentScriptOptions: {
			channelName: 'whatever you want',
			endAtPage: true			// true: communicate with the options page (not its content script)
		},
		onAttach: onWorkerAttach,
	});
}


//// low level communication

var id = function (msg,sender,sendResponse){sendResponse(msg)};
Browser.messageHandlers = {};
Browser.messageHandlers['id'] = id;

Browser._find_worker = function(tabId) {
	for (var i = 0; i < Browser.workers.length; i++)
		if (Browser.workers[i].tab && Browser.workers[i].tab.id == tabId)
			return Browser.workers[i];
	return null;
}

Browser.handleMessage = function(msg,sender,sendResponse) {
	// Browser.log('handling: ', msg, sender, sendResponse);
	return Browser.messageHandlers[msg.type].apply(null,[msg.message,sender,sendResponse]);
}

Browser.sendMessage = function (tabId, type, message, cb) {
	if (Browser._script == 'main') {
		var worker = Browser._find_worker(tabId);
		if(worker) {
			// Browser.log('-> ', worker.tab.url, message);
			worker.channel.sendMessage({'type': type, 'message': message},cb);
		} else {
			// cannot connect, call cb with no arguments
			if(cb) cb();
		}
	}
	// content or popup
	else {
		// Browser.log(' -> main', message);
		extension.sendMessage({'type': type, 'message': message},cb);
	}
};



//////////////////// rpc ///////////////////////////
//
//
// handler is a   function(...args..., tabId, replyHandler)
Browser.rpc.register = function(name, handler) {
	// set onMessage listener if called for first time
	if(!this._methods) {
		this._methods = {};
		Browser.messageHandlers['rpc'] = Browser.rpc._listener;

		if(Browser._script != 'main')	// the main script sets the listener on the channels it creates
			extension.onMessage.addListener(Browser.handleMessage);
	}
	this._methods[name] = handler;
}

// onMessage listener. Received messages are of the form
// { method: ..., args: ... }
//
Browser.rpc._listener = function(message, tabId, replyHandler) {
	//blog("RPC: got message", message, tabId, replyHandler);

	var handler = Browser.rpc._methods[message.method];
	if(!handler) {
		Browser.log('No handler for '+message.method);
		return;
	}

	// add tabId and replyHandler to the arguments
	var args = message.args || [];
	args.push(tabId, replyHandler);

	return handler.apply(null, args);
};

Browser.rpc.call = function(tabId, name, args, cb) {
	var message = { method: name, args: args };

	Browser.sendMessage(tabId, 'rpc', message, cb)
}


//////////////////// storage ///////////////////////////

Browser.storage._key = "global";		// store everything under this key
Browser.storage._init = function(){
	if (Browser._script == 'main') {

		var ss = require("sdk/simple-storage").storage;

		Browser.storage.get = function(cb) {
			var st = ss[Browser.storage._key];

			// default values
			if(!st) {
				// Browser.log('initializing settings');
				st = Browser.storage._default;
				Browser.storage.set(st);
			}
			// Browser.log('returning st');
			cb(st);
		};

		Browser.storage.set = function(st) {
			// Browser.log('setting st');
			ss[Browser.storage._key] = st;
		};

		Browser.storage.clear = function() {
			// Browser.log('clearing st');
			delete ss[Browser.storage._key];
		};

		Browser.rpc.register('storage.get',function(tabId,replyHandler){
			Browser.storage.get(replyHandler);
		});

		Browser.rpc.register('storage.set',function(st,tabId,replyHandler){
			Browser.storage.set(st);
			replyHandler();
		});
		Browser.rpc.register('storage.clear',function(){
			Browser.storage.clear();
		});

	}
	// content and popup
	else{

		Browser.storage.get = function(cb) {
			// Browser.log('getting state');
			Browser.rpc.call(null,'storage.get',null,cb);
		}

		Browser.storage.set = function(st) {
			// Browser.log('setting state');
			Browser.rpc.call(null,'storage.set',[st]);
		}

		Browser.storage.clear = function() {
			// Browser.log('clearing state');
			Browser.rpc.call(null,'storage.clear');
		}

	}
}


//////////////////// gui ///////////////////////////

// only called by main
Browser.gui._init = function(){

	var Cu = require("chrome").Cu;
	Cu.import("resource://gre/modules/Services.jsm");

	Browser.gui._fennec = Services.wm.getMostRecentWindow("navigator:browser").NativeWindow != undefined;

	if(Browser.gui._fennec) {
		Cu.import("resource://gre/modules/PageActions.jsm");
		Cu.import("resource://gre/modules/NetUtil.jsm");
		Cu.import("resource://gre/modules/Prompt.jsm");

	} else {
		var array = require('sdk/util/array');

		Browser.gui.badge = {
			theBadge : null,
			visible : false,
			enabled : false,
			disable : function(title) {  // visible but disabled
				Browser.log('disabling button');
				if (!Browser.gui.badge.visible) {
					this.enable("");
				}
				this.enabled = false;
				Browser.gui.badge.theBadge.setIcon({path: 'images/pin_disabled_38.png'});
				Browser.gui.badge.theBadge.setTitle({title : title});
			},
			enable : function(title) {	   // visible and enabled
				Browser.log('enabling button');

				if (!Browser.gui.badge.visible) {
					Browser.gui.badge.visible = true;

					Browser.gui.badge.theBadge = require('browserAction').BrowserAction({
						default_icon: 'images/pin_38.png',
						default_title: title,
						default_popup: 'popup.html',
					});
					Browser.gui.badge.theBadge.onMessage.addListener(function(msg, sender, sendResponse) {
						// set sender = "popup" (popup worker is registed with tabId = "popup")
						return Browser.handleMessage(msg, "popup", sendResponse);
					});
					array.add(Browser.workers, {"tab" : {"id" : "popup", "url" : "popup"}, 'channel': Browser.gui.badge.theBadge});
				}
				Browser.gui.badge.enabled = true;
				Browser.gui.badge.theBadge.setIcon({path: 'images/pin_38.png'});
				Browser.gui.badge.theBadge.setTitle({title : title});
			},
			hide : function() {
				Browser.log('hiding button');
				if (Browser.gui.badge.visible) {
					Browser.gui.badge.visible = false;
					Browser.gui.badge.enabled = false;
					Browser.gui.badge.theBadge.destroy();
					array.remove(Browser.workers, Browser._find_worker("popup"));
				}
			},
		};
	}

	// register rpc methods
	//
	Browser.rpc.register('getActiveCallUrl', function(tabId, replyHandler) {
		Browser.gui.getActiveCallUrl(replyHandler);
		return true;	// replyHandler will be used later
	});

	Browser.rpc.register('refreshIcon', function(tabId, callerTabId) {
		Browser.gui.refreshIcon(tabId || callerTabId);		// null tabId in the content script means refresh its own tab
	});

	Browser.rpc.register('refreshAllIcons', function() {
		Browser.gui.refreshAllIcons();
	});

	Browser.rpc.register('showPage', function(name) {
		Browser.gui.showPage(name);
	});

	// register options button
	//
	var prefsModule = require("sdk/simple-prefs");
	prefsModule.on("optionButton", function() {
		console.log("options was clicked");
		Browser.gui.showPage("options.html");
	})
}

Browser.gui._getActiveTab = function(){
	var tabs = require("sdk/tabs");
	return tabs.activeTab;
}

Browser.gui._refresh_pageaction = function(info) {
	 var nw = Services.wm.getMostRecentWindow("navigator:browser").NativeWindow;

	if(this._pageaction)
		PageActions.remove(this._pageaction);
	if(this._menu)
		 nw.menu.remove(this._menu);

	if(!info.apiCalled) {
		// no API call, show nothing
		return;

	} else if(info.hidden) {
		// if the API is called by the icon is hidden, add menu
		//
		this._menu = nw.menu.add({
			name: "Location Guard",
			callback: PopupFennec.show
		});

	} else {
		// load and cache icon in base64
		var icon = 'images/' + (info.private ? "pin_50.png" : "pin_disabled_50.png");
		if(!this._base64_cache)
			this._base64_cache = {};
		if(!this._base64_cache[icon])
			this._base64_cache[icon] = require('sdk/base64').encode( load_binary(icon) );

		this._pageaction = PageActions.add({
			icon: "data:image/png;base64," + this._base64_cache[icon],
			title: "Location Guard",
			clickCallback: PopupFennec.show
		});
	}

	/*
	nw.toast.show("Location Guard is enabled", "long", {
		button: {
			label: "SHOW",
			callback: PopupFennec.show
		}
	});
	*/
}

// the following 4 are the public methods of Browser.gui
//
Browser.gui.refreshIcon = function(tabId) {
	Browser.log('refreshing icon', tabId);

	if(Browser._script == 'main') {
		// refreshIcon is supposed to change the icon of a specific tab (or the active tab if tabId = null). In firefox
		// the icon is actually _global_, we update it on every tab change. So refreshIcon only needs to refresh the _active_
		// tab's icon (i.e. when tabId == null or tabId == activeTab.id).
		//
		if(tabId == undefined)
			throw "tabId not set";
		if(tabId != Browser.gui._getActiveTab().id)
			return;		// asked to refresh a non-active tab, nothing to do

		Util.getIconInfo(tabId, function(info) {
			Browser.log('got info for refreshIcon', info);

			if(Browser.gui._fennec) {
				Browser.gui._refresh_pageaction(info);
			} else {
				if(info.hidden)
					Browser.gui.badge.hide();
				else if(!info.private)
					Browser.gui.badge.disable(info.title);
				else
					Browser.gui.badge.enable(info.title);
			}
		});

	} else {
		// content popup
		// cannot do it in the content script, delegate to the main
		Browser.rpc.call(null, 'refreshIcon', [tabId]);
	}
};

Browser.gui.refreshAllIcons = function() {
	if(Browser._script == 'main')
		// in firefox the icon is global, we only need to refresh the active tab
		Browser.gui.refreshIcon(Browser.gui._getActiveTab().id);
	else
		Browser.rpc.call(null, 'refreshAllIcons');
};

Browser.gui.showPage = function(name) {
	Browser.log('showPage', name);

	if(Browser._script == 'main') {
		// if there is any tab showing an internal page, activate and update it, otherwise open new
		//
		var data = require("sdk/self").data;
		var baseUrl = data.url("");
		var fullUrl = baseUrl + name;

		if(this._fennec) {
			// sdk/tabs doesn't enumerate tabs correctly in fennec
			// maybe bug: https://bugzilla.mozilla.org/show_bug.cgi?id=844859
			// So we use BrowserApp instead
			//
			var ba = Services.wm.getMostRecentWindow("navigator:browser").BrowserApp;
			var tabs = ba.tabs;

			for(var i = 0; i < tabs.length; i++) {
				var url = tabs[i].window.location.href;
				if(url.search(baseUrl) != -1) {
					ba.selectTab(tabs[i]);
					if(url != fullUrl)		// if identical avoid reload
						tabs[i].browser.loadURI(fullUrl);
					return;
				}
			}

			ba.addTab(fullUrl);

		} else {
			var tabs = require("sdk/tabs");

			for(var i = 0; i < tabs.length; i++) {
				if(tabs[i].url.search(baseUrl) != -1) {
					tabs[i].url = fullUrl;
					tabs[i].activate();
					return;
				}
			}
			tabs.open(fullUrl);
		}

	} else {
		Browser.rpc.call(null, 'showPage', [name], null);
	}
};

Browser.gui.getActiveCallUrl = function(handler) {
	if(Browser._script == 'main') {
		// Note: the callUrl might come from a frame inside the page, from a different url than tab.url
		// We need to get it from the content script using the getState rpc call
		//
		var tab = Browser.gui._getActiveTab();
		Browser.rpc.call(tab.id, 'getState', [], function(state) {
			handler(state.callUrl);
		});
	} else {
		// cannot do it in the content script, delegate to the main
		Browser.rpc.call(null, 'getActiveCallUrl', [], handler)
	}
}


Browser.log = function() {
	if(!Browser.debugging) return;

    var args = Array.prototype.slice.call(arguments);	// convert to real array
	args.unshift(Browser._script + ":");

	console.log.apply(console, args);
}


// loads a binary file from the data directory
// same as data.load, but data.load does string conversion, and fails for binary
// files. It's a slight modification of readURISync (which is used by data.load)
// https://github.com/mozilla/addon-sdk/blob/master/lib/sdk/net/url.js
//
function load_binary(uri) {
	var data = require("sdk/self").data;
	var channel = NetUtil.newChannel(data.url(uri), null);
	var stream = channel.open();
	var count = stream.available();
	var data = NetUtil.readInputStreamToString(stream, count);
	stream.close();
	return data;
}

