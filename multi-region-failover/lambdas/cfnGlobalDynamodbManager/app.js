'use strict';
const GlobalDynamodbManager = require('./global-dynamodb-manager');

exports.handler = async (event, context) => {
    console.log(JSON.stringify(event), JSON.stringify(context));
    let manager = new GlobalDynamodbManager();
    await manager.processEvent(event, context);
};