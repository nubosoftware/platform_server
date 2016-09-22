"use strict";

var validate = require("validate.js");
var constraints = require("nubo-validateConstraints");
var async = require('async');
var Platform = require('./platform.js');
var ThreadedLogger = require('./ThreadedLogger.js');
var http = require('./http.js');

function connectToVpn(req, res, next) {
	var logger = new ThreadedLogger();

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

function connect(conf, logger, callback) {

	var platform = new Platform(logger);
	var cmd = "";

	if (conf.vpnType === 0) {
		cmd = 'am broadcast -n com.nubo.nubosettings/.receivers.VpnReceiver -a com.nubo.nubosettings.CONFIG_LEGACY_VPN --user 0';
	} else if (conf.vpnType === 1) {
		cmd = 'am broadcast -n com.nubo.nubosettings/.receivers.VpnReceiver -a com.nubo.nubosettings.CONFIG_OPENVPN --user ' + conf.userId;
	} else {
		logger.error("connect: unknown vpn request type");
		callback("unknown vpn request type")
		return;
	}

	platform.exec(cmd, function(err, code, signal, sshout) {
		if (err) {
			logger.error("connect: " + err);
			callback(err);
			return;
		}

		if (sshout.indexOf("result=0") === -1) {
			logger.error("connect: failed sending intent" + sshout);
			callback(sshout);
			return;
		}

		callback(null);
	});
}

function validateConnecToVpnRequestObj(requestObj, logger, callback) {

	callback(null, requestObj);
}

module.exports = {
	connectToVpn: connectToVpn
};