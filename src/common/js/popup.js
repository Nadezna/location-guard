browser = new Browser.Popup();
blog("loading");
browser.init();
browser.storage.get(function(g) { blog("settings", g) });

// get current tab's url
var url;
browser.gui.getActiveTabUrl(function(_url) {
	url = _url;
});

function closePopup() {
	// delay closing to allow scripts to finish executing
	setInterval(window.close, 50);	
}

function menuAction(action) {
	switch(action) {
		case 'options':
		case 'faq':
			var anchor = action == 'options' ? '#general' : '#faq';
			browser.gui.showOptions(anchor);

			closePopup();
			break;

		case 'hideIcon':
			browser.storage.get(function(st) {
				st.hideIcon = true;
				browser.storage.set(st);

				browser.gui.refreshAllIcons();

				closePopup();
			});
			break;

		case 'pause':
			browser.storage.get(function(st) {
				st.paused = !st.paused;
				browser.storage.set(st);

				browser.gui.refreshAllIcons();

				closePopup();
			});
			break;

		case 'setLevel':		// top menu, no need to do anything
			break;

		default:	// set level
			browser.storage.get(function(st) {
				var domain = Util.extractDomain(url);
				var level = action;
				if(level == st.defaultLevel)
					delete st.domainLevel[domain];
				else
					st.domainLevel[domain] = level;
				browser.storage.set(st);

				browser.gui.refreshAllIcons();

				closePopup();
			});
			break;
	}
}

function drawUI() {
	browser.storage.get(function(st) {
		var domain = Util.extractDomain(url);
		var level = st.domainLevel[domain] || st.defaultLevel;

		// for some reason the mouse gets a mouseover event when created, so it
		// highlights the first item. To avoid this, we create the menu as
		// disabled, and enable it after 50msecs
		$("#menu").menu({
			disabled: true,
			position: { my: "right bottom", at: "right bottom", of: $(window) },
			select: function(event, ui) {
				menuAction(ui.item.attr("id"));
			}
		});
		setTimeout(function() {
			$("#menu").menu({ disabled: false });
		}, 50);

		$("#title").text(
			st.paused		? "Location Guard is paused" :
			level == 'real'	? "Using your real location" :
			level == 'fixed'? "Using a fixed location" :
			"Privacy level: " + level
		);
		$("#pause > a").text((st.paused ? "Resume" : "Pause") + " Location Guard");

		$("#setLevel,#hideIcon").toggle(!st.paused);

		$("body").css("height", $("#container").height());
		$("body").css("width", $("#container").width()+13);
	});
}

$(document).ready(drawUI);

