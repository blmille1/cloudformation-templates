'use strict';
const AWS = require("aws-sdk");
const cfn = new AWS.CloudFormation();
const lambda = new AWS.Lambda();
const utils = require(process.env.AWS ? '/opt/nodejs/utils' : '../../utils/nodejs/utils');

exports.handler = async (event, context) => {
    var record, key;
    try {
        logObject(event, 'Processing stream event');
        for (record of event.Records) {
            key = record.dynamodb.Keys.key.S;
            switch (key) {
                case 'active-region':
                    await processActiveRegionChange(record);
                    break;
                // You can support other things like disabling import to database so you can deploy on a quiet database.
                default:
                    console.log(`Received ${key} key change.  Ignoring.`);
            }
        }
    } catch (ex) {
        await utils.catch(ex, JSON.stringify({ event, record, key, context }));
    }
};

async function processActiveRegionChange(record) {
    let oldRegion = record.dynamodb.OldImage && record.dynamodb.OldImage.value && record.dynamodb.OldImage.value.S || 'NOT SET';
    let newRegion = record.dynamodb.NewImage.value.S;
    // We don't want to check if old and new values are different in case we deployed and the deployment stomped the values.
    console.log(`active-region changed from ${oldRegion} to ${newRegion}`);
    let regionStatus = newRegion === process.env.AWS_REGION ? 'active' : 'inactive';
    
    console.log(`New Region Status: ${regionStatus}`);
    await updateFunctions(regionStatus);
    // You can also update alarms, schedules, etc. here.
    console.log('Done');
}


async function updateFunctions(regionStatus) {
    let functions = await getStackFunctions();
    for (let id of functions) {
        await utils.retry(5, 1_000, async() => { await updateFunctionConfiguration(id, regionStatus); });
    }
    console.log('Finished updating functions');
}

async function updateFunctionConfiguration(id, regionStatus) {
    console.log(`Updating ${id}`);
    let config = await lambda.getFunctionConfiguration({ FunctionName: id }).promise();
    let env = config.Environment.Variables;
    env.REGION_STATUS = regionStatus;
    let result = await lambda.updateFunctionConfiguration({ FunctionName: id, Environment: config.Environment}).promise();
}

async function getStackFunctions() {
    console.log(`List Stack Resources for ${process.env.STACK_NAME}`);
    let resources = await getAllStackResources();
    let functions = resources.filter(resource => resource.ResourceType === 'AWS::Lambda::Function').map(resource => resource.PhysicalResourceId);
    console.log(`Functions (${functions.length})`);
    return functions;
}

async function getAllStackResources() {
    let resources = [];
    let nextToken;
    do {
        let response = await cfn.listStackResources({StackName: process.env.STACK_NAME, NextToken: nextToken }).promise();
        resources.push(...response.StackResourceSummaries);
        nextToken = response.NextToken;
    } while (nextToken);
    return resources;
}

function logObject(obj, msg) {
    if (msg)
        console.log(msg);
    console.log(JSON.stringify(obj, null, 2));
}