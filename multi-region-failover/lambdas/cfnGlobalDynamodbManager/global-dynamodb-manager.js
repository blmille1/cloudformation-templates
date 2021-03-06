let EventEmitter = require('events').EventEmitter;
const utils = require(process.env.AWS ? '/opt/nodejs/utils' : '../../layers/utils/nodejs/utils');
const AWS = require('aws-sdk');
const cfnResponseAsync = require('cfn-response-async');

const defaultSchema = {
    AttributeDefinitions: [ { AttributeName: 'key', AttributeType: 'S' } ], 
    KeySchema: [ { AttributeName: 'key', KeyType: 'HASH' } ], 
    BillingMode: 'PAY_PER_REQUEST',
    TableName: 'config', // Fill in from properties
    StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
    Tags: []
};

class GlobalDynamodbManager extends EventEmitter {
    schema;
    pollInterval;
    localClient;
    farClient;
    constructor(schema, pollInterval) {
        super();
        this.schema = schema || defaultSchema;
        this.pollInterval = pollInterval || 5;
    }
    async processEvent(event, context) {
        let outputs = {};
        try {
            console.log('event', JSON.stringify(event), 'context', JSON.stringify(context));
            // Init
            this.localClient = new AWS.DynamoDB();
            this.farClient = this.localClient;
            if (process.env.AWS_REGION !== event.ResourceProperties.OriginalPrimaryRegion) {
                this.farClient = new AWS.DynamoDB({ region: event.ResourceProperties.OriginalPrimaryRegion });
            }

            // Process
            console.log(`Processing ${event.RequestType}`);
            switch(event.RequestType) {
                case 'Create':
                    outputs = await processCreate.call(this, event);
                    break;
                case 'Update':
                    outputs = await processUpdate.call(this, event, context);
                    break;
                case 'Delete':
                    outputs = await processDelete.call(this, event);
                    break;
            }
            console.log('outputs', JSON.stringify(outputs), 'context', JSON.stringify(context));
            await cfnResponseAsync.send(event, context, 'SUCCESS', outputs, context.PhysicalResourceId);
        } catch (ex) {
            console.error(`Error for request type ${event.RequestType}: `, ex);
            await utils.catch(ex, { event, context });
            await cfnResponseAsync.send(event, context, 'FAILED', outputs, context.PhysicalResourceId);
        }
    }
}

async function processCreate(event) {
    let outputs = {};
    // Always create the original table in the designated original region.
    // This is because we update that table to include the replaicated regions to it.
    // You can't delete the original table until all of the other replicas have been deleted.
    let primaryOriginalDescribeTableResult = await getPrimaryTable(this.farClient, event, this.schema, this.pollInterval);
    
    if (process.env.AWS_REGION === event.ResourceProperties.OriginalPrimaryRegion) {
        outputs.TableStreamArn = primaryOriginalDescribeTableResult.Table.LatestStreamArn;
        outputs.TableArn = primaryOriginalDescribeTableResult.Table.TableArn;
        return outputs;
    }

    // We're not in the original primary region
    let ourReplica = (primaryOriginalDescribeTableResult.Table.Replicas || []).filter(r => r.RegionName === process.env.AWS_REGION);
    
    if (ourReplica.length == 0)
        await createReplicaAndWait(this.farClient, event, this.pollInterval);

    let localReplicaDescribeTableResult = await waitUntilTableIsActive(this.localClient, event.ResourceProperties.TableName, this.pollInterval);

    // Tag new resource because tags don't automatically make it from the replicated table
    await tagResource(this.localClient, localReplicaDescribeTableResult.Table.TableArn, this.schema.Tags);
    
    outputs.TableStreamArn = localReplicaDescribeTableResult.Table.LatestStreamArn;
    outputs.TableArn = localReplicaDescribeTableResult.Table.TableArn;
    return outputs;
}

async function processUpdate(event, context) {
    let outputs = {};
    // At this point, we'll never delete the old resource
    context.PhysicalResourceId = event.PhysicalResourceId; // This prevents us from deleting our original resource
    populateSchema(this.schema, event);
    let localReplicaDescribeTableResult = await waitUntilTableIsActive(this.localClient, event.ResourceProperties.TableName, this.pollInterval);
    await tagResource(this.localClient, localReplicaDescribeTableResult.Table.TableArn, this.schema.Tags);
    outputs.TableStreamArn = localReplicaDescribeTableResult.Table.LatestStreamArn;
    outputs.TableArn = localReplicaDescribeTableResult.Table.TableArn;
    
    return outputs;
}

async function processDelete(event) {
    let outputs = {};
    // Only delete table if it's not the primary or if it is the primary and has no replicas.
    try {
        // If we get an error in here, we're going to assume that either the table doesn't exist or we're trying to delete a table that still has an active replica...
        let result = await waitUntilTableIsActive(this.localClient, event.ResourceProperties.TableName, this.pollInterval);
        let deleteTableResult = await this.localClient.deleteTable({ TableName: event.ResourceProperties.TableName }).promise();
        console.log(JSON.stringify(deleteTableResult));
        console.log(`Waiting until ${event.ResourceProperties.TableName} is deleted...`);
        await waitUntilTableIsDeleted(this.localClient, event.ResourceProperties.TableName, this.pollInterval);
    } catch (ex) {
        console.log(ex, 'We\'re assuming this is good... Continue with delete...');
        return outputs;
    }
    return outputs;
}

async function getPrimaryTable(client, event, schema, pollInterval) {
    console.log(`Original Primary Region: ${event.ResourceProperties.OriginalPrimaryRegion}`);
    populateSchema(schema, event);
    try {
        let result = await waitUntilTableIsActive(client, event.ResourceProperties.TableName, pollInterval);
        return result;
    } catch (ex) {
        console.log(`The table doesn't exist in the original primary region. Creating...`);
        let createTableResult = await client.createTable(schema).promise();
        console.log(JSON.stringify(createTableResult));
        let result = await waitUntilTableIsActive(client, event.ResourceProperties.TableName, pollInterval);
        return result;
    }
}

async function createReplicaAndWait(client, event, pollInterval) {
    let params = {
        TableName: event.ResourceProperties.TableName,
        ReplicaUpdates: [ { Create: { RegionName: process.env.AWS_REGION } } ]
    };
    console.log(`Creating replica with these params: `, JSON.stringify(params));
    let updateTableResult = await client.updateTable(params).promise();
    console.log(JSON.stringify(updateTableResult));
    let originalPrimaryRegionDescribeTableResult = await waitUntilTableIsActive(client, event.ResourceProperties.TableName, pollInterval);
    return originalPrimaryRegionDescribeTableResult;
}

async function tagResource(client, arn, tags) {
    console.log(`Tagging resource ${arn} in region ${client.config.region} with ${JSON.stringify(tags)}`);
    // Get the current tags
    console.log(`   Getting current tags...`)
    let currentTags = [];
    let nextToken;
    do {
        let currentTagsResponse = await client.listTagsOfResource({ ResourceArn: arn, NextToken: nextToken }).promise();
        currentTags.push(...currentTagsResponse.Tags);
        nextToken = currentTagsResponse.NextToken;
    } while(nextToken);
    console.log(JSON.stringify(currentTags));

    // Which tags need to be added/updated?
    let addOrUpdateTags = tags.filter(t => currentTags.filter(t2 => t2.Key === t.Key && t2.Value === t.Value).length === 0);
    console.log(`   Tags that need to be added/updated: ${JSON.stringify(addOrUpdateTags)}`);
    if (addOrUpdateTags.length > 0) {
        let tagResourceResult = await client.tagResource({ ResourceArn: arn, Tags: addOrUpdateTags }).promise();
        console.log('tagResource Response:', JSON.stringify(tagResourceResult));
    }

    // Which tags need to be deleted?
    let removeTags = currentTags.filter(ct => tags.filter(nt => nt.Key === ct.Key).length === 0).map(t => t.Key);
    console.log(`   Tags that need to be removed: ${JSON.stringify(removeTags)}`);
    if (removeTags.length > 0) {
        let untagResourceResult = await client.untagResource({ ResourceArn: arn, TagKeys: removeTags }).promise();
        console.log('untagResource Response:', JSON.stringify(untagResourceResult));
    }
    console.log('Tagging done.')
}

async function waitUntilTableIsActive(client, tableName, pollInterval = 5) {
    console.log(`Waiting for table ${tableName} in region ${client.config.region} to become ACTIVE`);
    do {
        let describeTableResult = await client.describeTable( { TableName: tableName } ).promise();
        console.log(JSON.stringify(describeTableResult));
        if (describeTableResult.Table.TableStatus === 'ACTIVE')
            return describeTableResult;
        console.log(`   Status: ${describeTableResult.Table.TableStatus}.  Waiting ${pollInterval} seconds...`);
        await utils.wait(pollInterval * 1_000);
    } while(true);
}

async function waitUntilTableIsDeleted(client, tableName, pollInterval) {
    console.log(`Waiting for table ${tableName} in region ${client.config.region} to delete...`);
    try {
        do {
            let describeTableResult = await client.describeTable( { TableName: tableName } ).promise();
            console.log(JSON.stringify(describeTableResult));
            console.log(`   Status: ${describeTableResult.Table.TableStatus}.  Waiting ${pollInterval} seconds...`);
            await utils.wait(pollInterval * 1_000);
        } while(true);
    } catch (ex) {
        if (ex.code === 'ResourceNotFoundException')
            console.log('   Deleted!');
        else
            throw ex;
    }
}

function populateSchema(schema, event) {
    schema.TableName = event.ResourceProperties.TableName;
    schema.Tags = event.ResourceProperties.Tags.map(t => {
        if (!t) return null;

        let pieces = t.split('=');
        if (pieces.length !== 2) {
            console.log(`Invalid Tag: ${t}. Skipping.`);
            return null;
        }
        return { Key: pieces[0].trim(), Value: pieces[1].trim() };
    }).filter(x => x);
}

module.exports = GlobalDynamodbManager;