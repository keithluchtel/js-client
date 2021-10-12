import { expect } from 'chai';
import nock = require('nock');
const fs = require('fs');

export const bulletinBoardHost = 'http://localhost:3000/';
export const OTPProviderHost = 'http://localhost:1111/';
export const voterAuthorizerHost = 'http://localhost:1234/';

export function deterministicRandomWords(nwords, _paranoia) {
  const lowestValidNumber = -2147483648;
  const highestValidNumber = 2147483647;

  if (typeof global.deterministicOffset == 'undefined') {
    resetDeterministicOffset();
  }

  let nextRandomInt = global.deterministicOffset;
  let output : number[] = []
  for (let i = 0; i < nwords; i++) {
    if (nextRandomInt > highestValidNumber) {
      nextRandomInt = lowestValidNumber
    }
    output.push(nextRandomInt++)
  }
  global.deterministicOffset++;

  return output
}

export function readJSON(path) {
  const data = fs.readFileSync(require.resolve(path));
  const json = JSON.parse(data);
  return json;
}

export function resetDeterministicOffset() {
  global.deterministicOffset = 0;
}

// Make Math.random deterministic when running tests
export function deterministicMathRandom() {
  return 0.42
}

export async function recordResponses(callback) {
  setupRecording();

  await callback.call()

  stopRecording();
  saveFiles();
  cleanup();
}

export async function expectError(promise: Promise<any>, errorType: any, message: string): Promise<any> {
  if (typeof promise == 'object') { // Async promise
    return promise
      .then(() => expect.fail('Expected promise to be rejected'))
      .catch(error => {
        expect(error).to.be.an.instanceof(errorType);
        expect(error.message).to.equal(message);
      });
  } else if (typeof promise == 'function') { // Synchronous function
    expect(
      () => promise()
    ).to.throw(errorType, message);
  }
}

function setupRecording() {
  nock.restore(); // Clear nock
  nock.recorder.clear(); // Clear recorder
  nock.recorder.rec({
    dont_print: true, // No stdout output
    output_objects: true // Returns objects instead of a string about recording
  });
}

function stopRecording() {
  nock.restore();
}

function saveFiles() {
  const indentationSpaces = 2;
  nock.recorder.play().forEach(function(record) {
    const filePath = filenameFromRequest(record.method, record.path);
    const json = JSON.stringify(record.response, null, indentationSpaces);
    try {
      fs.writeFileSync(filePath, json);
      console.debug(`Response written to ${filePath}`);
    } catch(error) {
      console.error(error);
    }
  });
}

function filenameFromRequest(httpMethod, url) {
  const extension = 'json';
  const targetDir = __dirname + '/replies/otp_flow/';

  const urlPathForFilename = url
    .replace(/^\//g, '') // Remove leading slash
    .replace(/=/g, "-") // Convert all '=' to '-', for example, 'foo?bar=1' becomes 'foo?bar-1'
    .replace(/[^\w-]+/g, "_") // Leave alphanumeric characters and dashes as is, convert everything else to underscores
    .toLowerCase() // Preventing filename case sensitivity issues before they become a pain

  const httpMethodForFilename = httpMethod.toLowerCase(); // Preventing filename case sensitivity issues
  const filename = `${httpMethodForFilename}_${urlPathForFilename}.${extension}`
  const absolutePath = targetDir + filename;

  return absolutePath;
}

function cleanup() {
  nock.recorder.clear();
  console.debug("Finished recording responses");
}
