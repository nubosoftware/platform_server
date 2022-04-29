"use strict";

const { execInHost } = require('./dockerUtils');

module.exports = {
    getRules,
    createChain,
    deleteRule,
    insertRule,
};

/**
 * Add rule on a specific index. if num is missing add to the start of the chain
 * @param {*} _chainName
 * @param {*} num
 * @param {*} ruleparams
 * @returns
 */
async function insertRule(_chainName,num,ruleparams) {
    let params = ['-I',_chainName];
    if (num) {
        params.push(num);
    }
    params = params.concat(ruleparams);
    let res = await execInHost("iptables", params);
    return true;
}

/**
 * Delete specific rule from _chainName at index num
 * @param {*} _chainName
 * @param {*} num
 * @returns
 */
async function deleteRule(_chainName,num) {
    let res = await execInHost("iptables", ['-D',_chainName,num]);
    return true;
}


/**
 * Create new chain
 * @param {*} _chainName
 * @returns
 */
async function createChain(_chainName) {
    let res = await execInHost("iptables", ['-N',_chainName]);
    return true;
}
/**
 * List all rules in a chain. If _chainName is missing, list all chains
 * @param {*} _chainName
 * @returns
 */
async function getRules(_chainName) {
    let params = ['-L', '--line-numbers'];
    if (_chainName) {
        params.splice(1, 0, _chainName);
    }

    let res = await execInHost("iptables", params);
    let chains = {};
    let chainName;
    let lines = res.stdout.split('\n');
    for (const line of lines) {
        let arr = line.split(/\s+/);
        if (arr[0] == "Chain") {
            chainName = arr[1];
            chains[chainName] = [];
        } else if (!isNaN(arr[0]) && parseInt(arr[0]) == arr[0]) {
            let item = {
                num: parseInt(arr[0]),
                target: arr[1],
                prot: arr[2],
                opt: arr[3],
                source: arr[4],
                destination: arr[5],
                additional: arr.slice(6).join(' ')
            }
            chains[chainName].push(item);

        }
    }
    //console.log(`chains: ${JSON.stringify(chains, null, 2)}`);
    return chains;
}