var rtc = require('rtc-tools');
var debug = rtc.logger('rtc-quickconnect');

/**
  Schemes allow multiple connection schemes for selection when attempting to connect to
  a peer
 **/
module.exports = function(signaller, opts) {

	var schemes = {};
	var _default;

	/**
	  Adds a connection scheme
	 **/
	function add(scheme) {
		// Ensure valid ID
		if (!scheme || !scheme.id || typeof scheme.id !== 'string') {
			throw new Error('Cannot add invalid scheme. Requires at least an ID');
		}
		// Unique schemes
		if (schemes[scheme.id]) {
			throw new Error('Scheme ' + schemeId + ' already exists');
		}
		// Check default
		if (scheme.default) {
			if (_default) {
				console.warn('Default scheme already exists');
			} else {
				_default = scheme.id;
			}
		}

		schemes[scheme.id] = scheme;
		debug('scheme added', scheme);
	}

	/**
	  Returns the scheme with the given ID. If canDefault is true it will return the default scheme
	  if no scheme with ID is found
	 **/
	function get(id, canDefault) {
		return schemes[id] || (canDefault && _default ? schemes[_default] : undefined);
	}

	// Load passed in schemes
	if (opts && opts.schemes && Array.isArray(opts.schemes)) {
		opts.schemes.forEach(add);
	}

	return {
		add: add,
		get: get
	};
};