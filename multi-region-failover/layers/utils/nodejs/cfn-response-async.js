const axios = require('axios');

exports.sendResponse = async (event, context, responseStatus, responseData, physicalResourceId) => {
    var reason = responseStatus == 'FAILED' ? ('See the details in CloudWatch Log Stream: ' + context.logStreamName) : undefined;

    var responseBody = JSON.stringify({
        StackId: event.StackId,
        RequestId: event.RequestId,
        Status: responseStatus,
        Reason: reason,
        PhysicalResourceId: physicalResourceId || context.logStreamName,
        LogicalResourceId: event.LogicalResourceId,
        Data: responseData
    });

    var responseOptions = {
        headers: {
            'Content-Type': '',
            'Content-Length': responseBody.length
        }
    };

    console.info('Response body:\n', responseBody);
    try {
        await axios.put(event.ResponseURL, responseBody, responseOptions);
        console.info('CloudFormationSendResponse Success');
    } catch (error) {
        console.error('CloudFormationSendResponse Error:');
        if (error.response) {
            console.error(error.response.data);
            console.error(error.response.status);
            console.error(error.response.headers);
        } else if (error.request) {
            console.error(error.request);
        } else {
            console.error('Error', error.message);
        }
        console.error(error.config);
        throw new Error('Could not send CloudFormation response');
    }
}