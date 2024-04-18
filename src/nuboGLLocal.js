"use strict";

const Common = require('./common.js');
var logger = Common.getLogger(__filename);
const path = require('path');
const spawn = require('child_process').spawn;
const dgram = require('node:dgram');
const { add } = require('winston');
const fs = require('fs');


class NuboGLLocal {

    session;
    child;
    gwRTPSSRC;
    tag;
    pooled;

    static sessions = {};

    constructor(session,pooled = false) {
        this.session = session;
        this.pooled = pooled;
        const key = `${session.params.localid}${pooled ? '-p' : ''}`;
        NuboGLLocal.sessions[key] = this;
        this.tag = `NuboGLLocal[${session.params.localid}${pooled ? '-p' : ''}]`;
    }

    static getSession(localid,pooled=false) {
        const key = `${localid}${pooled ? '-p' : ''}`;
        return NuboGLLocal.sessions[key];
    }

    udpSend(buf,host,port) {
        return new Promise((resolve, reject) => {
            const client = dgram.createSocket('udp4');
            client.connect(port, host, (err) => {
                if (err) {
                    logger.error("Error in udpSend: " + err);
                    reject(err);
                    return;
                }
                client.send(buf, (err) => {
                    if (err) {
                        logger.error("Error in sendUDP: " + err);
                        reject(err);
                        return;
                    }
                    console.log("Buffer been send " + buf.toString('hex'));
                    client.close();
                    resolve();
                });
            });
        });
    }

    async sendUDPSignal(signal) {
        try {
            const listenPort = this.session.params.nuboglListenPort;
            const listenHost = "127.0.0.1";//this.session.params.nuboglListenHost;
            const buf = Buffer.allocUnsafe(1);
            buf.writeInt8(signal);
            await this.udpSend(buf, listenHost, listenPort);
        } catch (err) {
            logger.error(`${this.tag} Error in sendUDPSignal: ${err}`);
        }
    }

    async init() {
        try {
            const platid = this.session.params.platid;
            const localid = this.session.params.localid;
            this.gwRTPSSRC = ((platid & 0xFFFF) << 16 ) | (localid & 0xFFFF);


            let gwRTPHost;
            let gwRTPPort;

            if (this.session.params.nuboGLAddress) {
                gwRTPHost = this.session.params.nuboGLAddress.split(":")[0];
                gwRTPPort = this.session.params.nuboGLAddress.split(":")[1];
            } else {
                gwRTPHost = "172.16.80.151";
                gwRTPPort = 60005;
            }
            // 1812x2176
            const width = this.session.params.width ? Number(this.session.params.width) : 540;
            const height = this.session.params.height ? Number(this.session.params.height) : 960;//1544;

            const encoder =  Common.nuboGL && Common.nuboGL.encoder ? Common.nuboGL.encoder :  "vaapih264enc";
            const listenPort = 22468 + Number(localid); // UDP port to listen for instructions from the gateway

            logger.info(`${this.tag} Creating nubo gl local process. platid: ${platid}, localid: ${localid}, gwRTPSSRC: ${this.gwRTPSSRC}, pooled: ${this.pooled}, width: ${width}, height: ${height}, encoder: ${encoder}, listenPort: ${listenPort}`);
            // 1 - play , 2 - pause
            var args = [
                gwRTPHost,
                gwRTPPort,
                this.gwRTPSSRC,
                width,
                height,
                encoder,
                listenPort,
            ];
            this.session.params.nuboglListenPort = listenPort;
            // this.session.params.nuboglListenHost
            const loggerName = `nubogl-${localid}${this.pooled ? "-p" : ""}`;
            const stdoutStream = fs.createWriteStream(`${Common.rootDir}/log/${loggerName}-out.log`);
            const stderrStream = fs.createWriteStream(`${Common.rootDir}/log/${loggerName}-err.log`);
            const nuboglPath = path.resolve(`./bin/nubogl`);
            logger.info(`${this.tag} Spawning nubogl: ${nuboglPath} ${args.join(" ")}`);
            var child = spawn('/usr/bin/stdbuf', ['-oL', '-eL', nuboglPath].concat(args), {
                cwd: this.session.params.sessPath,
                // uid : 1000,
                // gid : 1000,
                env: {
                    ...process.env,
                    //"DISPLAY": ":0",
                    //"XDG_RUNTIME_DIR": "/run/user/0",

                    // "XAUTHORITY": "/home/israel/.Xauthority",
                    //"XAUTHORITY": "/run/user/1002/.mutter-Xwaylandauth.0U6ZG2",
                    // "GST_VAAPI_ALL_DRIVERS": "1",
                    // "GST_DEBUG": "4",
                },
                stdio: ['inherit', 'pipe', 'pipe'], // Use 'pipe' for stdout and stderr
            });

            // Pipe child's stdout and stderr to file
            child.stdout.pipe(stdoutStream);
            child.stderr.pipe(stderrStream);

            // child.stdout.on('data', (data) => {
            //     logger.info(`${this.tag} stdout: ${data}`);
            // });

            // child.stderr.on('data', (data) => {
            //     logger.info(`${this.tag} stderr: ${data}`);
            // });

            child.on('close', (code) => {
                logger.info(`${this.tag} child process exited with code ${code}`);
                this.child = null;

            });
            this.child = child;
            logger.info(`${this.tag} Spawned child pid: ${child.pid}`);

        } catch (err) {
            logger.error(`${this.tag} Error in NuboGLLocal init: ${err}`);
        }
    }

    async afterAndroidStart() {
        try {
            logger.info(`${this.tag} afterAndroidStart`);
            await this.sendUDPSignal(1);
            // change resolution: 4 (byte) + width (int32) + height (int32)
        } catch (err) {
            logger.error(`${this.tag} Error in afterAndroidStart: ${err}`);
        }
    }

    async changeResolution(width, height) {
        try {
            logger.info(`${this.tag} changeResolution. width: ${width}, height: ${height}`);
            const buf = Buffer.allocUnsafe(9);
            buf.writeInt8(4);
            buf.writeInt32LE(width, 1);
            buf.writeInt32LE(height, 5);
            const listenPort = this.session.params.nuboglListenPort;
            const listenHost = "127.0.0.1";//this.session.params.nuboglListenHost;
            await this.udpSend(buf, listenHost, listenPort);
        } catch (err) {
            logger.error(`${this.tag} Error in changeResolution: ${err}`);
        }
    }

    async setNuboGLAddress(addr) {
        try {
            // for debug only: replace the port number :port with :60015
            // addr = addr.replace(/:\d+$/, ":1234");
            // remove after debug!!
            logger.info(`${this.tag} setNuboGLAddress. addr: ${addr}`);
            const buf = Buffer.allocUnsafe(2 + addr.length);
            buf.writeInt8(5);
            buf.writeInt8(addr.length,1);
            buf.write(addr, 2);
            const listenPort = this.session.params.nuboglListenPort;
            const listenHost = "127.0.0.1";
            await this.udpSend(buf, listenHost, listenPort);
        } catch (err) {
            logger.error(`${this.tag} Error in setNuboGLAddress: ${err}`);
        }
    }


    async killSession(wait = false) {
        try {
            const child = this.child;
            if (child) {
                logger.info(`${this.tag} killing child pid: ${child.pid}, wait: ${wait}`);
                let waitKillPromise;
                if (wait) {
                    waitKillPromise = new Promise((resolve, reject) => {
                        child.on('close', (code) => {
                            logger.info(`${this.tag} child process exited with code ${code}`);
                            this.child = null;
                            resolve();
                        });
                    });
                }
                child.kill();
                if (wait) {
                    await waitKillPromise;
                }

            }
            const key = `${this.session.params.localid}${this.pooled ? '-p' : ''}`;
            delete NuboGLLocal.sessions[key];
            logger.info(`${this.tag} Nubo gl deleted.`);

        } catch (err) {
            logger.error(`${this.tag} Error in killSession: ${err}`);
        }
    }
    static async killSession(localid,pooled, wait = false) {
        try {
            const session = NuboGLLocal.getSession(localid,pooled);
            if (session) {
                await session.killSession(wait);
            } else {
                logger.info(`NuboGLLocal. killSession. session not found. localid: ${localid}, wait: ${wait}`);
            }
        } catch (err) {
            logger.error(`NuboGLLocal Error in killSession: ${err}`);
        }
    }
}


module.exports = NuboGLLocal;
