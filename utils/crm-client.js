const fetch = require('node-fetch');
const validateConfig = require('./validate-config');
const ADALClient = require('./ADAL-client');

const CRM_API_CONFIG = validateConfig({
  CRM_HOST: process.env.CRM_HOST,
  CRM_URL_PATH: process.env.CRM_URL_PATH,
});

const CRM_URL = `${CRM_API_CONFIG.CRM_HOST}${CRM_API_CONFIG.CRM_URL_PATH}`;
const BATCH_NAME = 'batch';
const OBJECT_REFERENCE_RETRIES = process.env.OBJECT_REFERENCE_RETRIES || 1;

class CRMClient {
  constructor() {
    this.ADALClient = new ADALClient();
  }

  /**
   * Returns access token from the ADAL Client
   */
  async getToken() {
    return this.ADALClient.acquireToken();
  }

  /**
   * Returns headers for CRM requests
   */
  async getHeaders(isBatch = false) {
    const contentType = isBatch ? `multipart/mixed;boundary=${BATCH_NAME}` : 'application/json; charset=utf-8';
    return {
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': contentType,
      Authorization: `Bearer ${await this.getToken()}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
      Prefer: 'odata.include-annotations="*"',
    };
  }

  /**
   * Wrapper to use fetch API to make requests to the CRM.
   * Returns an object containing json-parsed response body as `content`,
   * and the HTTP response status as `status`, even in the event of non-200
   * responses. On Error from fetch, throws a generic error that CRMClient failed.
   */
  async doFetch(method, query, data = null, isBatch = false) {
    try {
      const headers = await this.getHeaders(isBatch);
      const options = {
        method,
        headers,
      };
      if (method !== 'GET' && data) {
        options.body = typeof data === 'object' ? JSON.stringify(data) : data;
      }

      const res = await fetch(`${CRM_URL}${query}`, options);
      let text = await res.text();

      if(isBatch) {
        text = CRMClient.extractBatchData(text);
      }

      try {
        const json = JSON.parse(text, this.dateReviver);
        return { status: res.status, content: json };
      } catch {
        // some HTTP errors are returned as a string, not a JSON response
        return { status: res.status, content: { error: { message: text  } } };
      }
    } catch (err) {
      console.log(err);  // eslint-disable-line
      throw new Error(`CRMClient failed to do ${method} request`);
    }
  }

  /**
   * Extract the JSON string object data from batch POST response.
   * Response format:
      --batchresponse_[UUID]
      Content-Type: application/http
      Content-Transfer-Encoding: binary

      HTTP/1.1 200 OK
      Content-Type: application/json; odata.metadata = minimal
      OData-Version: 4.0

      [object data JSON string]
      --batchresponse_[UUID]--
   */
  static extractBatchData(textContent) {
    const batchStart = '--batchresponse_[-0-9a-fA-F]+\\s';
    const headers = '(?:[-\\w\\s\\/\\.;:=]+\\s)\\s';
    const httpStatus = 'HTTP\\/\\d\\.\\d\\s\\d+\\s[-\\s\\w]+\\s';
    const jsonData = '(\\{.*\\})\\s+';
    const batchEnd = '--batchresponse_[-0-9a-fA-F]+--';

    const batchResponseRegExp = new RegExp(batchStart + headers + httpStatus + headers + jsonData + batchEnd);

    const match = textContent.match(batchResponseRegExp)
    if (match) {
      return match[1];
    }
  }
  /**
   * Reviver function for json parsing CRM response body, to convert
   * timestamp strings to Date objects
   */
  static dateReviver(key, value) {
    // If value is NOT a valid date, return it as is
    if (Math.isNaN(Date.parse(value))) {
      return value;
    }
    // Return the date object
    return new Date(value);
  }

  /**
   * Wrapper to execute doFetch() with a retry for specific 'Object reference error'
   * request failure, which occurs intermittently for GET, PUT, and PATCH requests.
   */
  async doFetchWithRetry(method, query, data, isBatch) {
    let tries = OBJECT_REFERENCE_RETRIES + 1;
    let res;
    while (tries) {
      res = await this.doFetch(method, query, data, isBatch);  // eslint-disable-line

      // Retry on object reference error
      if (res.content.error && CRMClient.isObjectReferenceError(res.content.error)) {
        tries -= tries;
        continue; // eslint-disable-line
      }
      return res;
    }

    throw new Error(res.content.error);
  }

  /**
   * Returns true if a given error message matches the 'Object Reference Error' message,
   * otherwise returns false.
   */
  static isObjectReferenceError(error) {
    const OBJECT_REFERENCE_ERROR = 'Object reference not set to an instance of an object.';
    if (error.message && error.message === OBJECT_REFERENCE_ERROR) {
      return true;
    }

    return false;
  }

  /**
   * Executes GET request with retry. Returns the processed response on success, or false on failure
   */
  async doGet(query) {
    const res = await this.doFetchWithRetry('GET', query);
    if (!res.content.error && res.status === 200) {
      return CRMClient.processGetResponse(res.content);
    }
    
    console.log(`GET request failed with status: ${res.status}, error: ${res.content.error.message}`); // eslint-disable-line
    return false;
  }

  /**
   * Executes PATCH request. Returns the response content on success, or false on failure
   */
  async doPatch(query, body) {
    const res = await this.doFetch('PATCH', query, body); // eslint-disable-line
    if (!res.content.error && res.status >= 200 && res.status < 300) { // TODO: Confirm correct status for PATCH resp
      return res.content;
    }

    console.log(`PATCH request failed with status: ${res.status}, error: ${res.content.error.message}`); // eslint-disable-line
    return false;
  }

  /**
   * Executes POST request with retry. Returns the response content on success, or false on failure.
   */
  async doPost(query, body, isBatch) {
    const res = await this.doFetchWithRetry('POST', query, body, isBatch);
    if (res && !res.content.error && res.status === 200) { // TODO: Confirm correct status for POST resp
      return res.content;
    }

    console.log(`POST request failed with status: ${res.status}, error: ${res.content.error.message}`); // eslint-disable-line
    return false;
  }

  async doBatchPost(query, fetchXML) {
    const batchBody = CRMClient.makeBatchBody(query, fetchXML);
    return this.doPost('$batch', batchBody, true); 
  }

  static makeBatchBody(query, fetchXML) {
    return `
--${BATCH_NAME}
Content-Type: application/http
Content-Transfer-Encoding: binary

GET ${CRM_URL}${query}?fetchXml=${fetchXML} HTTP/1.1
Content-Type: application/json
OData-Version: 4.0
OData-MaxCersion: 4.0

--${BATCH_NAME}--
`;
  }

  /**
   * Executes DELETE request. Returns the response content on success, or false on failure.
   */
  async doDelete(query) {
    const res = this.doFetch('DELETE', query);
    if (!res.content.error && res.status === 200) { // TODO: Confirm correct status for DELETE resp
      return res.content;
    }

    console.log(`DELETE request failed with status: ${res.status}, error: ${res.content.error.message}`); // eslint-disable-line
    return false;
  }

  /**
   * Processes get response by parsing object entities with prefixed property names.
   */
  static processGetResponse(json) {
    if (json['@odata.context'].includes('/$entity')) {
      return this.parsePrefixedEntity(json);
    }

    if (json.value) {
      json.value = json.value.map(entity => this.parsePrefixedEntity(entity));
    }
    return json;
  }

  /**
   * Normalizes prefixed property names, and returns an object containing all properties
   * with correct (either original or normalized) name.
   */
  static parsePrefixedEntity(data) {
    const normalizedObject = {};
    Object.keys(data).forEach((propertyName) => {
      const normalizedPropertyName = this.getNormalizedPropertyName(propertyName);
      normalizedObject[normalizedPropertyName] = data[propertyName];
    });
    return normalizedObject;
  }

  /**
   * Returns the normalized property name if the name is prefixed with
   * FORMATTED_VALUE prefix, LOGICAL_NAME prefix, or NAVIGATION_PROPERTY prefix;
   * otherwise returns the original property name.
   */
  static getNormalizedPropertyName(propertyName) {
    const FORMATTED_VALUE = '@OData.Community.Display.V1.FormattedValue';
    const LOGICAL_NAME = '@Microsoft.Dynamics.CRM.lookuplogicalname';
    const NAVIGATION_PROPERTY = '@Microsoft.Dynamics.CRM.associatednavigationproperty';

    let index;
    let suffix;
    if (propertyName.includes(FORMATTED_VALUE)) {
      index = propertyName.indexOf(FORMATTED_VALUE);
      suffix = '_formatted';
    }

    if (propertyName.includes(LOGICAL_NAME)) {
      index = propertyName.indexOf(LOGICAL_NAME);
      suffix = '_logical';
    }

    if (propertyName.includes(NAVIGATION_PROPERTY)) {
      index = propertyName.indexOf(NAVIGATION_PROPERTY);
      suffix = '_navigationproperty';
    }

    return (index && suffix) ? propertyName.substring(0, index) + suffix : propertyName;
  }
}

module.exports = CRMClient;