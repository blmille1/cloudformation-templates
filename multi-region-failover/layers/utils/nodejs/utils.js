const cfnSendResponseAsync = require('./cfn-response-async').sendResponse;

function wait(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

async function catchFn(ex, args) {
    console.error(ex, JSON.stringify(args));
}

async function retry(maxTries, waitTimeInMs, callback) {
    let numTries = 0;
    while (numTries < maxTries) {
        try {
            numTries++;
            return await callback();
        } catch(ex) {

            if (numTries == maxTries) {
                if (typeof(ex) === "string")
                    ex = new Error(ex);
                throw ex;
            }

            log(ex, `Num Tries: ${numTries} - waiting ${waitTimeInMs}ms and trying again`);

            await wait(waitTimeInMs);
        }
    }
}

function log(...msg) {
    if (process.env.LOG =='true' || process.env.LOG == undefined ) {
        msg.push(`Memory Used: ${Math.round(process.memoryUsage().heapUsed/10_485.760)/100} MB`)

        console.log(...msg);
    }
}

exports.cfnSendResponseAsync = cfnSendResponseAsync;
exports.wait = wait;
exports.catch = catchFn;
exports.retry = retry;
exports.log = log;