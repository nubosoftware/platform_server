"use strict";

var async = require('async');
var fs = require('fs');
var validate = require("validate.js");
var Platform = require('./platform.js');
const machineModule = require('./machine.js');
var ThreadedLogger = require('./ThreadedLogger.js');
var http = require('./http.js');
var Common = require('./common.js');
const path = require('path');
const { logger } = require('./common.js');
const { execDockerCmd , ExecCmdError } = require('./dockerUtils');
const { stdout } = require('process');

module.exports = {
    installApk: installApk,
    attachApps: attachApps,
    getPackagesList: getPackagesList
};

var INSTALL_TASK = [1, "i", "install"];
var UNINSTALL_TASK = [0, "u", "uninstall"];

function installApk(req, res) {
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    var apk = req.params.apk;
    // Test for path manipulation
    if ((apk.indexOf('..') >= 0) || (apk.indexOf('/data/tmp/') !== 0)) {
        var resobj = {
            status: 0,
            msg: 'Invalid file name'
        };
        res.end(JSON.stringify(resobj, null, 2));
        logger.error("Fail process request installApk");
        return;
    }
    logger.logTime("Start process request installApk");

    tryInstallApk(apk, 1, 0, logger, function(err, msg) {
        var resobj;
        if (err) {
            logger.error("Cannot install apk " + apk + "\nOutput:\n" + msg);
            resobj = {
                status: 0,
                msg: msg
            };
        } else {
            logger.info("Apk " + apk + " installed");
            resobj = {
                status: 1,
                msg: "OK"
            };

        }
        res.end(JSON.stringify(resobj, null, 2));
        logger.logTime("Finish process request installApk");
    });
}

var tryInstallApk = function(apkPath, retries, wait, logger, callback) {
    var msg = "";
    var platform = new Platform(logger);
    logger.info("Try install apk " + apkPath);
    var retryInstallApk = function(path, retries, wait, logger, callback) {
        if (retries < 1) {
            callback("Cannot install apk", msg);
        } else {
            platform.execFile("pm", ["install", "--user", "0", "-r", apkPath], function(err, stdout, stderr) {
                if (err) {
                    if (stderr.indexOf("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]") === -1) {
                        msg += apkPath + ":\n" + stderr;
                        setTimeout(function() {
                            retryInstallApk(apkPath, retries - 1, wait, logger, callback);
                        }, wait);
                    } else {
                        callback(null);
                    }
                } else {
                    //disableUserZero(apkPath,platform,logger);
                    callback(null);
                }
            });
        }
    };
    retryInstallApk(apkPath, retries, wait, logger, callback);
};

var disableUserZero = function(apkPath,platform,logger, callback) {
    let packagename = path.basename(apkPath, '.apk');
    platform.execFile("pm", ["disable", "--user", "0", packagename], function(err, stdout, stderr) {
        if (err) {
            logger.info(`disableUserZero. packagename: ${packagename}, err: ${err}, stdout: ${stdout}, stderr: ${stderr}`);
        }
        if (callback) {
            callback(null);
        }
    });
}

/*
 * Send data:
 *  {data: [{packageName, unum, task}, ...]
 *   task: 1,"i", "install" for installation; 0, "u", "uninstall" for uninstallation
 */
function attachApps(req, res) {
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    logger.logTime("Start process request attachApps");
    var obj = req.body;

    async.waterfall(
        [
            //create workable android user
            function(callback) {
                if (obj.tasks.length > 0) {
                    processTasks(obj.tasks, logger, callback);
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
        ],
        function(err) {
            logger.logTime("Finish process request attachApps");
        }
    );
}

var detachApps = function(req, res) {

};


var installAppInBackgrond = function(containerId,installTarget) {    
    
    execDockerCmd(
        ['exec' , containerId, '/usr/bin/apt', 'install' , '-y' , installTarget]
    ).then(obj => {
        const { stdout, stderr } = obj;
        logger.info(`Installed package ${installTarget} on container ${containerId}.\nstdout: ${stdout}\nstderr: ${stderr}`);
    }).catch(e => {
        const {err,stdout,stderr} = e;
        logger.info(`Error installing package ${installTarget} on container ${containerId}.\nError: ${e}\nstdout: ${stdout}\nstderr: ${stderr}`);
    });
    
}

var processTasksDocker = async function(tasks, logger) {
    let errFlag = false;
    let results = [];
    for (const task of tasks) {
        try {
            logger.info(`processTasksDocker task: ${JSON.stringify(task,null,2)}`);
            // load the user session
            let session = await require('./user').loadUserSessionPromise(task.unum,logger);
            const containerId = session.params.containerId;

            if (INSTALL_TASK.indexOf(task.task) !== -1) {
                let installTarget = task.packageName;                
                if (task.filename) {
                    // we will need to copy the file into the container
                    let debPath = path.resolve("./debs",task.filename);
                    installTarget = `/root/${task.filename}`;

                    await execDockerCmd(
                        ['cp' , debPath, `${containerId}:${installTarget}`]
                    );
                }
                // run the install command
                logger.info(`Installing in background. package: ${installTarget}, container: ${containerId}`);
                installAppInBackgrond(containerId,installTarget);                
                task.status = 1;
            } else if (UNINSTALL_TASK.indexOf(task.task) !== -1) {
                // run the install command
                const { stdout, stderr } = await execDockerCmd(
                    ['exec' , containerId, '/usr/bin/apt', 'purge' , '-y', task.packageName]
                );
                logger.info(`Uninstalled package ${task.packageName} on container ${containerId}.\nstdout: ${stdout}\nstderr: ${stderr}`);
                task.status = 1;
            } else {
                task.status = 0;
                task.statusMsg = "Bad task";
                errFlag = true;
            }
        } catch (err) {
            logger.info(`processTasksDocker. Error execute task: ${err}`);
            if (err instanceof ExecCmdError) {
                logger.info(`processTasksDocker. stdout: ${err.stdout}\n stderr: ${err.stderr}`);
            }
            task.status = 0;
            task.statusMsg = `${err}`;            
            errFlag = true;
        }
        results.push(task);
    }
    return({
        errFlag,
        results
    });
}

var processTasks = function(tasks, logger, callback) {
    if (machineModule.isDockerPlatform()) {
        processTasksDocker(tasks,logger).then((result) => {
            const {results, errFlag } = result;
            callback(null, results, errFlag);
        }).catch(err => {
            callback(null, [], true);
        });
        return;
    }
    var platform = new Platform(logger);
    var results = [];
    var errFlag = false;
    async.eachSeries(
        tasks,
        function(task, callback) {
            var cmd;
            logger.info(`processTasks task: ${JSON.stringify(task,null,2)}`);
            if (INSTALL_TASK.indexOf(task.task) !== -1) {
                platform.execFile("pm", ["install", "--user", task.unum, task.packageName], function(err, stdout, stderr) {
                    if (err) {
                        task.status = 0;
                        task.statusMsg = stderr;
                        errFlag = true;
                    } else {
                        task.status = 1;
                    }
                    results.push(task);
                    callback(null);
                });
            } else if (UNINSTALL_TASK.indexOf(task.task) !== -1) {
                cmd = 'pm uninstall --user ' + task.unum + ' ' + task.packageName;
                platform.execFile("pm", ["uninstall", "--user", task.unum, task.packageName], function(err, stdout, stderr) {
                    if (err) {
                        task.status = 0;
                        task.statusMsg = stderr;
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

function getPackagesList(req, res) {
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    var filter = req.params.filter;

    logger.logTime("Start process request getPackagesList");
    var platform = new Platform(logger);
    var data;
    async.waterfall(
        [
            //get data from packages.list
            function(callback) {
                fs.readFile("/Android/data/system/packages.list", function(err, data) {
                    if (err) {
                        callback(err);
                    } else {
                        callback(null, data.toString());
                    }
                });
            },
            //parse data
            function(rawdata, callback) {
                var packagesObjArray = [];
                var lines = rawdata.split("\n");
                lines.forEach(function(line) {
                    if (line !== "") {
                        var fields = line.split(" ");
                        var packagesObj = {
                            packageName: fields[0],
                            offset: fields[1]
                        };
                        if (!filter || (filter && filter === packagesObj.packageName)) {
                            packagesObjArray.push(packagesObj);
                        }
                    }
                });
                callback(null, packagesObjArray);
            },
        ],
        function(err, data) {
            var resobj = {};
            if (err) {
                resobj.status = 0;
                resobj.msg = err;
            } else {
                resobj.status = 1;
                resobj.data = data;
            }
            res.end(JSON.stringify(resobj, null, 2));
            //logger.info("resobj: " + JSON.stringify(resobj, null, 2));
            //logger.logTime("Finish process request getPackagesList");
        }
    );
}

var validateAttachAppsRequestObj = function(reqestObj, logger, callback) {
    var validate = require("validate.js");
    var constraints = require("@nubosoftware/nubo-validateconstraints")(validate);

    var constraint = {
        tasks: {
            isArray: true,
            array: {
                packageName: constraints.packageNameConstrRequested,
                unum: constraints.IndexConstrRequested,
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
    if (res) logger.error("input is not valid: " + JSON.stringify(res));
    callback(res, reqestObj);
};
