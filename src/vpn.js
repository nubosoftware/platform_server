"use strict";


var async = require('async');
var Platform = require('./platform.js');
var ThreadedLogger = require('./ThreadedLogger.js');
var http = require('./http.js');
var Common = require('./common.js');
var { execDockerWaitAndroid } = require('./dockerUtils.js');

function connectToVpn(req, res, next) {
	var logger = new ThreadedLogger(Common.getLogger(__filename));

	async.waterfall(
		[
			//get data from post request
			function(callback) {
				http.getObjFromRequest(req, callback);
			},
			function(reqestObj, callback) {
				validateConnecToVpnRequestObj(reqestObj, logger, callback);
			},
			//create workable android user
			function(reqestObj, callback) {
				connect(reqestObj, logger, callback);
			}
		],
		function(err) {

			if (err) {
				logger.error("connectToVpn: " + err);
			}

			var resobj = {
				status: err ? 0 : 1,
				message: err
			};
			res.end(JSON.stringify(resobj, null, 2));
		}
	);


}

async function connect(conf, logger, callback) {

	var amArgs;
	// vpnType 0 targets the system user (0); vpnType 1 targets the work user,
	// which inside the session container is always user 10.
	if (conf.vpnType === 0) {
	    amArgs = ["broadcast", "-n", "com.nubo.nubosettings/.receivers.VpnReceiver", "-a", "com.nubo.nubosettings.CONFIG_LEGACY_VPN", "--user", "0"];
	} else if (conf.vpnType === 1) {
		amArgs = ["broadcast", "-n", "com.nubo.nubosettings/.receivers.VpnReceiver", "-a", "com.nubo.nubosettings.CONFIG_OPENVPN", "--user", "10"];
	} else {
		logger.error("connect: unknown vpn request type");
		callback("unknown vpn request type");
		return;
	}

	try {
		var userModule = require('./user.js');
		let session = await userModule.loadUserSessionPromise(conf.userId, logger);
		const containerId = session.params.containerId;
		const dockerArgs = ["exec", containerId, "am"].concat(amArgs);
		logger.info("connect. Command: docker " + dockerArgs);
		const {stdout, stderr} = await execDockerWaitAndroid(dockerArgs);

		if (stdout.indexOf("result=0") === -1) {
			logger.error("connect: failed sending intent" + stdout);
			callback(stdout);
			return;
		}

		callback(null);
	} catch (err) {
		logger.error("connect: " + err);
		callback(`${err}`);
	}
}

function validateConnecToVpnRequestObj(requestObj, logger, callback) {

	callback(null, requestObj);
}

module.exports = {
	connectToVpn: connectToVpn
};
