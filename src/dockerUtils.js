"use strict";
const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const execFile = require('child_process').execFile;
const _ = require('underscore');


class ExecCmdError extends Error {
    constructor(msg,err,stdout,stderr) {
        super(msg);
        this.err = err;
        this.stdout = stdout;
        this.stderr = stderr;
    }
}


module.exports = {
    docker,
    followProgress,
    pullImage,
    execCmd,
    execDockerCmd,
    ExecCmdError,
    execInHost,
    execDockerWaitAndroid,
    sleep
};


function execInHost(cmd,params,options) {
    return new Promise((resolve, reject) => {
        let opts = {maxBuffer: 1024 * 1024 * 10};
        if (options) {
            _.extend(opts, options)
        }
        execFile(cmd, params, opts , function (error, stdout, stderr) {
            if (error) {
                let e = new ExecCmdError(`${error}`,error,stdout,stderr);
                reject(e);
            }
            resolve({
                stdout,
                stderr
            });
            return;
        });
    });
}


function execDockerCmd(params,options) {
    return execInHost('/usr/bin/docker',params,options);
}

/**
 * Exec doocker command but what until android is up and able to process command
 * @param {*} params
 * @param {*} options
 * @returns
 */
async function execDockerWaitAndroid(params,options) {
    const MAX_TRIES = 120;
    const WAIT_MS = 1000;
    const reasons = ["OCI runtime exec failed",
        "Can't find service",
        "Cannot access system provider",
        "NullPointerException",
        "Failure calling service package"];
    let tries = 0;
    while (tries<MAX_TRIES) {
        try {
            tries++;
            const res = await execDockerCmd(params,options);
            return res;
        } catch (err) {
            if (err instanceof ExecCmdError) {
                //console.log(`processTasksDocker. stdout: ${err.stdout}\n stderr: ${err.stderr}`);
                if (tries<MAX_TRIES) {
                    let foundWaitReason = false;
                    for (const reason of reasons) {
                        if (err.stderr.indexOf(reason) >= 0 || err.stdout.indexOf(reason) >= 0) {
                            console.log(`execDockerWaitAndroid. wait for Android to start. stdout: ${err.stdout}, stderr: ${err.stderr}`);
                            foundWaitReason = true;
                            break;
                        }
                    }
                    if (foundWaitReason) {
                        await sleep(WAIT_MS);
                        continue;
                    }
                }
            }
            throw err;
        }
    }
}

function sleep(ms) {
    return new Promise((resolve, reject) => {
        setTimeout( () => {
            resolve();
        },ms);
    });
}

async function execCmd(container, cmd) {
    let exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    })
    let out = "";
    let st = await exec.start();
    for await (const chunk of st) {
        //console.log('>>> '+chunk);
        out += chunk;
    }
    let insp = await exec.inspect();
    insp.Output = out;
    return insp;
}
function followProgress(stream) {
    return new Promise((resolve,reject) => {
        docker.modem.followProgress(stream,onFinished,onProgress);
        function onFinished(err, output) {
            //console.log(`onFinished. err: ${err}`);
            if (err) {
                reject(err);
            } else {
                resolve(output);
            }
          }
          function onProgress(event) {
            //console.log(`onProgress event: ${JSON.stringify(event,null,2)}`);
          }

     });
}
async function pullImage(fullName) {
    //let fullName = registryURL + imageName;
    //let stream = await docker.pull(fullName);
    //let output = await followProgress(stream);
    //console.log(`Pull result: ${output}`);
    await execDockerCmd(['pull',fullName]);

    return;
}