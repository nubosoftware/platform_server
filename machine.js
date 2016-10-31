"use strict";

var path = require("path");
var async = require('async');
var _ = require('underscore');
var http = require('./http.js');
var exec = require('child_process').exec;
var execFile = require('child_process').execFile;
var ThreadedLogger = require('./ThreadedLogger.js');
var Platform = require('./platform.js');


var flagInitAndroidStatus = 0; // 0: not yet done, 1: in progress, 2: done
var RESTfull_message = "the platform not yet initialized";

function startPlatformGet(req, res) {
    var resobj = {
        status: 1,
        msg: RESTfull_message,
        androidStatus: flagInitAndroidStatus
    };
    res.end(JSON.stringify(resobj, null, 2));
}

function startPlatformPost(req, res) {
    var logger = new ThreadedLogger();
    var requestObj;
    var requestInProgress = true;

    if (flagInitAndroidStatus > 0) {
        var resobj = {status: 0};
        if (flagInitAndroidStatus === 1) resobj.msg = "Init Android OS in progress";
        if (flagInitAndroidStatus === 2) resobj.msg = "Init Android OS already done";
        res.end(JSON.stringify(resobj, null, 2));
        return;
    }
    flagInitAndroidStatus = 1;
    var requestKeepAliveInterval = setInterval(
        function() {
            res.writeContinue();
        },
        1000
    );

    logger.logTime("Start process request startPlatform");
    async.waterfall(
        [
        //get data from post request
        function(callback) {
            http.getObjFromRequest(req, function(err, obj) {
                requestObj = obj;
                callback(err, obj);
            });
        },
        function (requestObj, callback) {
            logger.info("startPlatform request data: " + JSON.stringify(requestObj));
            validateStartPlatformRequestObj(requestObj, logger, callback);
        },
        function(callback) {
            getFiles(requestObj, logger, callback);
        },
        function(callback) {
            RESTfull_message = "preset platform parameters";
            logger.info(RESTfull_message);
            setParametersOnMachine(requestObj, logger, callback);
        },
        function(callback) {
            logger.debug("startPlatform: preconfigure vpn");
            preVpnConfiguration(logger, callback);
        },
        function(callback) {
            RESTfull_message = "init android";
            logger.info(RESTfull_message);
            initAndroid(requestObj, logger, callback);
        },
        function(callback) {
            RESTfull_message = "post boot procedures";
            logger.info(RESTfull_message);
            afterInitAndroid(requestObj, logger, callback);
        }
    ], function(err) {
        clearInterval(requestKeepAliveInterval);
        var resobj = {};
        if (err) {
            RESTfull_message = "Start android failed";
            logger.error("Error during start platform: " + err);
            resobj.status = 0;
            resobj.msg = err;
            flagInitAndroidStatus = 3;
        } else {
            RESTfull_message = "Android run";
            resobj.status = 1;
            flagInitAndroidStatus = 2;
        }
        res.end(JSON.stringify(resobj, null, 2));
        logger.logTime("Finish process request startPlatform");
    });
}

var validateStartPlatformRequestObj = function(reqestObj, logger, callback) {
    var validate = require("validate.js");
    var constraints = require("nubo-validateConstraints");

    var constraint = {
        platid: constraints.platIdConstrRequested,
        platUID: constraints.requestedPlatformUIDConstr,
        gateway: {presence: true},
        "gateway.apps_port": constraints.portNumberConstrRequested,
        "gateway.external_ip": {},                      //not in use
        "gateway.player_port": {},                      //not in use
        "gateway.ssl": {},                              //not in use
        "gateway.index": {},                            //not in use
        "gateway.internal_ip": constraints.ipConstrOptional,
        "gateway.isGWDisabled": {},                     //not in use
        "gateway.controller_port": constraints.portNumberConstrRequested,
        management: {presence: true},
        "management.url": constraints.hostConstr,
        "management.ip": constraints.ipConstrRequested,
        nfs: {presence: true},
        "nfs.nfs_ip": constraints.ipConstrRequested,
        "nfs.ssh_ip": {},                               //not in use
        "nfs.ssh_user": {},                             //not in use
        "nfs.key_path": {},                             //not in use
        "nfs.nfs_path": constraints.pathConstr,
        downloadFilesList: {array: constraints.pathConstr},
        settings: {presence: true},
        "settings.withService": constraints.boolConstrOptional,
        "settings.hideControlPanel": constraints.boolConstrOptional,
        rsyslog: {},
        "rsyslog.ip": constraints.ipConstrOptional,
        "rsyslog.port": constraints.ipConstrOptional
    };
    var res = validate(reqestObj, constraint);
    callback(res);
};

function killPlatform(req, res) {
    var resobj;
    resobj.status = 0;
    resobj.msg = "Not implemented";
    res.end(JSON.stringify(resobj, null, 2));
}

var setParametersOnMachine = function(obj, logger, callback) {
    var sed_replacer = function(key, value) {
        return "sed \"s,\\(^" + key + "=\\).*,\\1" + value + ",\" -i /opt/Android/init-files.sh";
    };
    async.series(
        [
        function(callback) {
            var cmd = "";
            if (obj.platid) {
                cmd += sed_replacer("PlatformID", obj.platid) + " && ";
            }
            if (obj.gateway) {
                cmd += sed_replacer("GatewayURL", obj.gateway.internal_ip) + " && ";
            }
            if (obj.management) {
                var url = obj.management.url;
                var re = new RegExp('http[s]?://([^/:]*)/?');
                var m = re.exec(url);
                cmd += sed_replacer("ManagementURL", url) + " && ";
                cmd += sed_replacer("ManagementHostName", m[1]) + " && ";
                if(obj.management.ip) {
                    cmd += sed_replacer("ManagementIP", obj.management.ip) + " && ";
                }
            }
            if (obj.nfs) {
                cmd += sed_replacer("NFSPREF", obj.nfs.nfs_ip + ":" + obj.nfs.nfs_path) + " && ";
            }
            if(obj.platUID) {
                cmd += sed_replacer("PlatformUID", obj.platUID) + " && ";
            }

            cmd += "true";
            exec(cmd, function(error, stdout, stderr) {
                if (error) {
                    logger.error("cmd: " + cmd);
                    logger.error("error: " + JSON.stringify(error, null, 2));
                    logger.error("stdout: " + stdout);
                    logger.error("stderr: " + stderr);
                }
                callback(error);
            });
        }
    ], function(err) {
        callback(err);
        }
    );
};

var initAndroid = function(reqestObj, logger, callback) {
    var cmd = "/opt/Android/init-files.sh";
    exec(cmd, function(error, stdout, stderr) {
        if (error) {
            logger.error("cmd: " + cmd);
            logger.error("error: " + JSON.stringify(error, null, 2));
            logger.error("stdout: " + stdout);
            logger.error("stderr: " + stderr);
        }
        callback(error);
    });
};

var afterInitAndroid = function(reqestObj, logger, callback) {
    var platform = new Platform(logger);
    async.series(
        [
            function(callback) {
                var nfsoptions = "nolock,hard,intr,vers=3,nosharecache,noatime,async"; //user 0
                var src = [
                    reqestObj.nfs.nfs_ip + ":" + reqestObj.nfs.nfs_path +"/apks"
                ];
                var dst = [
                    "/Android/data/tmp"
                ];
                require('./mount.js').mountHostNfs(src, dst, nfsoptions, function(err) {
                    if (err) {
                        logger.error("Cannot mount apks, err: " + err);
                    }
                    callback(err);
                });
            },
            function(callback) {
                var timeoutSec = 90;
                logger.info("Waiting upto " + timeoutSec + " seconds for android ssh server...");
                waitForProcessWithTimeout("/system/bin/sshd", timeoutSec, callback);
            },
            function(callback) {
                if(reqestObj.rsyslog && reqestObj.rsyslog.ip) {
                    var cmd = "busybox syslogd -R " + reqestObj.rsyslog.ip + " ; busybox klogd";
                    logger.info("cmd: " + cmd);
                    platform.exec(cmd, function(err, code, signal, sshout) {
                        callback(null);
                    });
                } else {
                    callback(null);
                }
            },
            function(callback) {
                var timeoutSec = 900;
                logger.info("Waiting upto " + timeoutSec + " seconds for 1st boot of android...");
                waitForProcessWithTimeout("android.process.acore", timeoutSec, callback);
            },
            function(callback) {
                setTimeout(function() {callback(null);}, 30*1000);
            },
            function(callback) {
                var cmd = "enable_houdini;pm refresh 0";
                logger.info("cmd: " + cmd);
                platform.exec(cmd, function(err, code, signal, sshout) {
                    callback(null);
                });
            },
            function(callback) {
                var timeoutSec = 300;
                logger.info("Waiting upto " + timeoutSec + " seconds for restart of android...");
                waitForProcessWithTimeout("android.process.acore", timeoutSec, callback);
            },
            function(callback) {
                if(reqestObj.settings.withService){
                    var cmd = "setprop ro.kernel.withService withService";
                    logger.info("cmd: " + cmd);
                    platform.exec(cmd, function(err, code, signal, sshout) {
                        callback(null);
                    });
                }
                else
                    callback(null);
            },
            function(callback) {
                if(reqestObj.settings.hideControlPanel){
                    var cmd = "setprop ro.kernel.hideControlPanel hideControlPanel";
                    logger.info("cmd: " + cmd);
                    platform.exec(cmd, function(err, code, signal, sshout) {
                        callback(null);
                    });
                }
                else
                    callback(null);
            },
            function(callback) {
                setTimeout(function() {callback(null);}, 10*1000);
            }
        ], function(err) {
       callback(err);
        }
    );
};

var waitForProcessWithTimeout = function(name, timeoutSec, callback) {
    var timeoutFlag = false;
    var timeoutObj = setTimeout(function() {
        timeoutFlag = true;
    }, timeoutSec * 1000); // setTimeout
    var getPid = function(callback) {
        if (timeoutFlag) callback("timeout");
        else {
            setTimeout(function() {
                exec("pidof " + name, function(error, stdout, stderr) {
                    if (error) {
                        getPid(callback);
                    } else {
                        clearTimeout(timeoutObj);
                        callback(null);
                    }
                });
            }, 4 * 1000);
        }
    };
    getPid(callback);
};

function checkPlatformStatus(req, res) {

    var logger = new ThreadedLogger();
    var platform = new Platform(logger);
    var userName = req.params.username ? req.params.username : null;
    var deviceID = req.params.deviceid ? req.params.deviceid : null;
    var platformIP = req.params.platformip ? req.params.platformip : null;
    var resobj = {
        status: 0,
        error: 'no error'
    };


    async.series([
        function(callback) {
            if(!userName || !deviceID || !platformIP)
                callback("missing parameters");
            else
                callback(null);
        },
        //check platform responsiveness
        function(callback) {
            var cmd = "pm list users";
            platform.exec(cmd, function(err, code, signal, sshout) {
                if (err) {
                    callback(err);
                    return;
                }
                callback(null);
            });
        },
        //Check userlist.xml file exists
        function(callback) {
            var cmd = "netcfg";
            platform.exec(cmd, function(err, code, signal, sshout) {
                if (err) {
                    callback(err);
                    return;
                }
                var n = sshout.search("eth0[\t ]*UP[\t ]*" + platformIP + "/");
                if (n >= 0) {
                    callback(null);
                } else {
                    callback("dead platform");
                }
            });
        },
        //Check if such user already exist and !!!do nothing!!!
        function(callback) {
            // skip this check
            callback(null);
            return;

            var cmd = 'grep "<name>' + userName + deviceID + '</name>" /data/system/users/[0-9]*.xml';
            platform.exec(cmd, function(err, code, signal, sshout) {
                if (err) {
                    callback(err);
                    return;
                }
                var n = sshout.indexOf(UserName);
                if (n >= 0) {
                    var msg = "duplicate user id";
                    callback(msg);
                    return;
                }
                callback(null);
            }); // ssh.exec
        }
    ], function(err) {
        if (err) {
            logger.error("checkStatus: " + err);
            resobj.status = 0;
            resobj.error = err;
            res.end(JSON.stringify(resobj, null, 2));
            return;
        }

        resobj.status = 1;
        res.end(JSON.stringify(resobj, null, 2));
    });
}


//remove symbol / from end of management url
var normalizeServerURL = function(url) {
    return url.replace(/[\/]+$/, "");
};

var getFiles = function(reqestObj, logger, callback) {
    var wgetArgsList;
    if(reqestObj.downloadFilesList) {
        wgetArgsList = _.map(reqestObj.downloadFilesList, function(item) {
            var wgetInput = normalizeServerURL(reqestObj.management.url) + item;
            var wgetOutput = "/opt/Android/" + path.basename(item);
            return [wgetInput, "-qO", wgetOutput];
        });
    } else {
        logger.info("Start android without files updating");
        return callback(null);
    }
    logger.info("wget arguments: " + JSON.stringify(wgetArgsList));

    async.series(
        [
            function(callback) {
                async.eachSeries(
                    wgetArgsList,
                    function(item, callback) {
                        execFile("wget", item, function(error, stdout, stderr) {
                            if(error) {
                                logger.error("Cannot download file " + item[0] + ", err: " + error);
                            }
                            callback(error);
                        });
                    },
                    callback
                );
            }
        ], function(err) {
            if(err) {
                logger.error("getFiles failed with err: " + err);
            }
            callback(err);
        }
    );
};

function preVpnConfiguration(logger, callback){
        async.series([
            //must load iptables before android platform starts, so netd can config init rules
            function(callback) {
                execFile("modprobe", ["iptable_nat"], function(error, stdout, stderr) {
                    if(error){
                        logger.debug("preVpnConfiguration: stdout: " + stdout);
                    }
                    callback(error);
                });
            },
            function(callback) {
                execFile("modprobe", ["iptable_raw"], function(error, stdout, stderr) {
                    if(error){
                        logger.error("preVpnConfiguration: stdout: " + stdout);
                    }
                    callback(error);
                });
            },
            function(callback) {
                execFile("modprobe", ["iptable_mangle"], function(error, stdout, stderr) {
                    if(error){
                        logger.error("preVpnConfiguration: stdout: " + stdout);
                    }
                    callback(error);
                });
            },
            function(callback) {
                execFile("modprobe", ["iptable_filter"], function(error, stdout, stderr) {
                    if(error){
                        logger.error("preVpnConfiguration: stdout: " + stdout);
                    }
                    callback(error);
                });
            },
            function(callback) {
                execFile("modprobe", ["tun"], function(error, stdout, stderr) {
                    if(error){
                        logger.error("preVpnConfiguration: stdout: " + stdout);
                    }
                    callback(error);
                });
            },/*
            // need to load for legacy vpn
            function(callback) {
                execFile("modprobe", ["pppolac"], function(error, stdout, stderr) {
                    if(error){
                        logger.error("preVpnConfiguration: stdout: " + stdout);
                    }
                    callback(error);
                });
            },
            // need to load for legacy vpn
            function(callback) {
                execFile("modprobe", ["pppopns"], function(error, stdout, stderr) {
                    if(error){
                        logger.error("preVpnConfiguration: stdout: " + stdout);
                    }
                    callback(error);
                });
            },*/
            // since vpn requires asymetric routing this parameter need to be set so
            // each new interface will be set with it (only vpn new interfaces should created)
            function(callback) {
                execFile("sysctl", ["net.ipv4.conf.default.rp_filter=2"], callback);
            }
        ], function(err) {
            if(err) {
                logger.error("preVpnConfiguration: " + err);
            }
            callback(err);
        }
    );
}

module.exports = {
    startPlatformGet: startPlatformGet,
    startPlatformPost: startPlatformPost,
    killPlatform: killPlatform,
    checkPlatformStatus: checkPlatformStatus
};

