"use strict";

var async = require('async');
var validate = require("validate.js");
var Platform = require('./platform.js');
var ThreadedLogger = require('./ThreadedLogger.js');
var http = require('./http.js');

module.exports = {
    installApk: installApk,
    attachApps: attachApps,
    getPackagesList: getPackagesList
};

var INSTALL_TASK = [1, "i", "install"];
var UNINSTALL_TASK = [0, "u", "uninstall"];

function installApk(req, res) {
    var logger = new ThreadedLogger();
    var apk = req.params.apk;
    // Test for path manipulation
    if ((apk.indexOf('..') >= 0) || (apk.indexOf('/data/tmp/') !== 0)) {
        var resobj = {status: 0, msg: 'Invalid file name'};
        res.end(JSON.stringify(resobj, null, 2));
        logger.error("Fail process request installApk");
        return;
    }
    logger.logTime("Start process request installApk");

    tryInstallApk(apk, 1, 0, logger, function(err, msg) {
        var resobj;
        if(err) {
            logger.error("Cannot install apk " + apk + "\nOutput:\n" + msg);
            resobj = {status: 0, msg: msg};
        } else {
            logger.info("Apk " + apk + " installed");
            resobj = {status: 1, msg: "OK"};
        }
        res.end(JSON.stringify(resobj, null, 2));
        logger.logTime("Finish process request installApk");
    });
}

var tryInstallApk = function(apkPath, retries, wait, logger, callback) {
    var cmd = 'pm install --user 0 -r ' + apkPath;
    var msg = "";
    var platform = new Platform(logger);
    logger.info("Try install apk " + apkPath);
    var retryInstallApk = function(path, retries, wait, logger, callback) {
        if(retries < 1) {
            callback("Cannot install apk", msg);
        } else {
            platform.exec(cmd, function(err, code, signal, sshout) {
                var installationFail = (sshout.indexOf("Success") === -1) &&
                    (sshout.indexOf("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]") === -1);
                if(installationFail) {
                    msg += cmd + "\n" + sshout;
                    setTimeout(function() {
                        retryInstallApk(apkPath, retries - 1, wait, logger, callback);
                    }, wait);
                } else {
                    callback(null);
                }
            });
        }
    };
    retryInstallApk(apkPath, retries, wait, logger, callback);
};

/*
 * Send data:
 *  {data: [{packageName, unum, task}, ...]
 *   task: 1,"i", "install" for installation; 0, "u", "uninstall" for uninstallation
 */
function attachApps(req, res) {
    var logger = new ThreadedLogger();
    logger.logTime("Start process request attachApps");
    async.waterfall(
        [
            //get data from post request
            function(callback) {
                http.getObjFromRequest(req, function(err, obj) {
                    callback(err, obj);
                });
            },
            function (reqestObj, callback) {
                validateAttachAppsRequestObj(reqestObj, logger, callback);
            },
            //create workable android user
            function(reqestObj, callback) {
                if(reqestObj.tasks.length > 0) {
                    processTasks(reqestObj.tasks, logger, callback);
                } else {
                    callback(null, [], true);
                }
            },
            function(tasksResult, errFlag, callback) {
                var resobj = {
                    status: errFlag ? 0 : 1,
                    results: tasksResult
                };
                res.end(JSON.stringify(resobj, null, 2));
                callback(null);
            }
        ], function(err) {
            logger.logTime("Finish process request attachApps");
        }
    );
}

var detachApps = function(req, res) {

};

var processTasks = function(tasks, logger, callback) {
    var platform = new Platform(logger);
    var results = [];
    var errFlag = false;
    async.eachSeries(
        tasks,
        function(task, callback) {
            var cmd;
            logger.info("processTasks task: " + task);
            if(INSTALL_TASK.indexOf(task.task) !== -1) {
                cmd = 'pm install --user ' + task.unum + ' ' + task.packageName;
                platform.exec(cmd, function(err, code, signal, sshout) {
                    if(sshout.indexOf("Success") === -1) {
                        task.status = 0;
                        task.statusMsg = sshout;
                        errFlag = true;
                    } else {
                        task.status = 1;
                    }
                    results.push(task);
                    callback(null);
                });
            } else if(UNINSTALL_TASK.indexOf(task.task) !== -1) {
                cmd = 'pm uninstall --user ' + task.unum + ' ' + task.packageName;
                platform.exec(cmd, function(err, code, signal, sshout) {
                    if(sshout.indexOf("Success") === -1) {
                        task.status = 0;
                        task.statusMsg = sshout;
                        errFlag = true;
                    } else {
                        task.status = 1;
                    }
                    results.push(task);
                    callback(null);
                });
            } else {
                task.status = 0;
                task.statusMsg = "Bad task";
                errFlag = true;
                results.push(task);
                callback(null);
            }
        },
        function(err) {
            logger.info("processTasks results: ", results);
            callback(null, results, errFlag);
        }
    );
};

function getPackagesList(req,res) {
    var logger = new ThreadedLogger();
    var filter = req.params.filter;

    logger.logTime("Start process request getPackagesList");
    var platform = new Platform(logger);
    var data;
    async.waterfall(
        [
            //get data from packages.list
            function(callback) {
                var cmd = "cat /data/system/packages.list";
                if(filter) cmd += " | grep \"" + filter + "\"";
                platform.exec(cmd, function(err, code, signal, sshout) {
                    callback(err, sshout);
                });
            },
            //parse data
            function(rawdata, callback) {
                var packagesObjArray = [];
                var lines = rawdata.split("\n");
                lines.forEach(function(line) {
                    if((line !== "") && (line !== "void endpwent()(3) is not implemented on Android")) {
                        var fields = line.split(" ");
                        var packagesObj = {
                            packageName: fields[0],
                            offset: fields[1]
                        };
                        packagesObjArray.push(packagesObj);
                    }
                });
                callback(null, packagesObjArray);
            },
        ], function(err, data) {
            var resobj = {};
            if(err) {
                resobj.status = 0;
                resobj.msg = err;
            } else {
                resobj.status = 1;
                resobj.data = data;
            }
            res.end(JSON.stringify(resobj, null, 2));
            logger.info("resobj: " + JSON.stringify(resobj, null, 2));
            logger.logTime("Finish process request getPackagesList");
        }
    );
}

var validateAttachAppsRequestObj = function(reqestObj, logger, callback) {
    var validate = require("validate.js");
    var constraints = require("nubo-validateConstraints");

    var constraint = {
        tasks: {
            isArray: true,
            array : {
                packageName: constraints.packagenameConstrRequested,
                unum: constraints.requestedIndexConstr,
                task: {
                    presence: true,
                    inclusion: {
                        within: [0, 1]
                    }
                }
            }
        }
    };
    var res = validate(reqestObj, constraint);
    if(res) logger.error("input is not valid: " + JSON.stringify(res));
    callback(res, reqestObj);
};

