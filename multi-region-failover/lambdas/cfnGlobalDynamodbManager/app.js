'use strict';
const GlobalDynamodbManager = require('./global-dynamodb-manager');

exports.handler = async (event, context) => {
    let manager = new GlobalDynamodbManager();
    await manager.processEvent(event, context);
};