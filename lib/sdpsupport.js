var compareVersions = require('compare-versions');

// Plan B semantic
var PLAN_B = 'plan-b';
var UNIFIED_PLAN = 'unified-plan';
var DEFAULT_SEMANTIC = PLAN_B;

// Indivates the 
var BROWSER_SUPPORT = {
    'chrome': {
        '71.0.0.0': [UNIFIED_PLAN, PLAN_B], // Prefer unified plan
        '70.0.0.0': [PLAN_B, UNIFIED_PLAN], // Prefer plan b
        '30.0.0.0': [PLAN_B]
    },
    'firefox': {
        '22.0': [UNIFIED_PLAN]
    },
    'ios': {
        '12.1': [UNIFIED_PLAN, PLAN_B], // 12.1.1 problem 12.3 iphone
        '12.0': [PLAN_B, UNIFIED_PLAN], // 12.xxx
        '11.0': [PLAN_B]
    },
    'safari': {
        '12.1': [UNIFIED_PLAN, PLAN_B],
        '12.0': [PLAN_B, UNIFIED_PLAN], // currently, worked one
        '11.0': [PLAN_B]
    }
};
var DEFAULT_SUPPORT = [DEFAULT_SEMANTIC];

/**
 * getSupportedSemantics
 * Returns which SDP semantics are supported by the given peer attributes
 */
function getSupportedSemantics(data) {
    if (!data || !data.browser || !data.browserVersion) return DEFAULT_SUPPORT;

    var versions = BROWSER_SUPPORT[data.browser];
    if (!versions) return DEFAULT_SUPPORT;

    return Object.keys(versions).filter(function(v) {
        return compareVersions(data.browserVersion, v) >= 0;
    }).map(function(v) {
        return versions[v];
    })[0] || DEFAULT_SUPPORT;
}

/**
 * detectTargetSemantics
 * Attempts to determine the best SDP semantic to achieve a connection between this peer,
 * and the peer it is connecting to
 */
exports.detectTargetSemantics = function(signaller, peer) {
    if (!peer || !signaller || !signaller.attributes) return DEFAULT_SEMANTIC;

    // Have the master be the source, so that we can correctly identify a preferred semantic
    // in the event of different prioritization (using different semantics would be a problem)
    var isMaster = signaller.isMaster(peer.id);
    var source = getSupportedSemantics(isMaster ? signaller.attributes : peer);
    var target = getSupportedSemantics(isMaster ? peer : signaller.attributes);
    return source.filter(function(semantic) {
        return target.indexOf(semantic) !== -1;
    })[0] || DEFAULT_SEMANTIC;
};