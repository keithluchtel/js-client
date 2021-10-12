import { AVClient } from '../lib/av_client';
import { expect } from 'chai';
import nock = require('nock');
import {
  deterministicRandomWords,
  deterministicMathRandom,
  expectError,
  resetDeterministicOffset,
  bulletinBoardHost,
  OTPProviderHost,
  voterAuthorizerHost
} from './test_helpers';
import sinon = require('sinon');
const sjcl = require('../lib/av_client/sjcl')

describe('AVClient#spoilBallotCryptograms', () => {
  let client: AVClient;
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(Math, 'random').callsFake(deterministicMathRandom);
    sandbox.stub(sjcl.prng.prototype, 'randomWords').callsFake(deterministicRandomWords);
    resetDeterministicOffset();
  });

  afterEach(() => {
    sandbox.restore();
    nock.cleanAll();
  });

  context('given valid values', () => {
    beforeEach(async () => {
      nock(bulletinBoardHost).get('/test/app/config')
        .replyWithFile(200, __dirname + '/replies/otp_flow/get_test_app_config.json');

      nock(voterAuthorizerHost).post('/create_session')
        .replyWithFile(200, __dirname + '/replies/otp_flow/post_create_session.json');
      nock(voterAuthorizerHost).post('/request_authorization')
        .replyWithFile(200, __dirname + '/replies/otp_flow/post_request_authorization.json');

      nock(OTPProviderHost).post('/authorize')
        .replyWithFile(200, __dirname + '/replies/otp_flow/post_authorize.json');

      nock(bulletinBoardHost).post('/test/app/register')
        .replyWithFile(200, __dirname + '/replies/otp_flow/post_test_app_register.json');
      nock(bulletinBoardHost).post('/test/app/challenge_empty_cryptograms')
        .replyWithFile(200, __dirname + '/replies/otp_flow/post_test_app_challenge_empty_cryptograms.json');

      client = new AVClient('http://localhost:3000/test/app');
      await client.initialize()
    });

    context('all systems work', () => {
      it('resolves without errors', async () => {
        nock(bulletinBoardHost).post('/test/app/get_commitment_opening')
          .replyWithFile(200, __dirname + '/replies/get_commitment_opening.valid.json');

        await client.requestAccessCode('voter123', 'voter@foo.bar');
        await client.validateAccessCode('1234');
        await client.registerVoter()

        const cvr = { '1': 'option1', '2': 'optiona' };
        await client.constructBallotCryptograms(cvr);
        client.generateTestCode();

        const result = await client.spoilBallotCryptograms();
        expect(result).to.equal(undefined);
      });
    });

    context('remote errors', () => {
      it('returns an error message when there is a network error', async () => {
        nock(bulletinBoardHost).post('/test/app/get_commitment_opening').reply(404);

        await client.requestAccessCode('voter123', 'voter@foo.bar');
        await client.validateAccessCode('1234');
        await client.registerVoter()

        const cvr = { '1': 'option1', '2': 'optiona' };
        await client.constructBallotCryptograms(cvr);
        client.generateTestCode();

        await expectError(
          client.spoilBallotCryptograms(),
          Error,
          'Request failed with status code 404'
        );
      });

      it('returns an error message when there is a server error', async () => {
        nock(bulletinBoardHost).post('/test/app/get_commitment_opening').reply(500, { nonsense: 'garbage' });

        await client.requestAccessCode('voter123', 'voter@foo.bar');
        await client.validateAccessCode('1234');
        await client.registerVoter()

        const cvr = { '1': 'option1', '2': 'optiona' };
        await client.constructBallotCryptograms(cvr);
        client.generateTestCode();

        await expectError(
          client.spoilBallotCryptograms(),
          Error,
          'Request failed with status code 500'
        );
      });
    });
  });

  context('submitting after spoiling', () => {
    it('returns an error when getting latest board hash', async () => {
      nock(bulletinBoardHost).get('/test/app/config')
        .replyWithFile(200, __dirname + '/replies/otp_flow/get_test_app_config.json');

      nock(voterAuthorizerHost).post('/create_session')
        .replyWithFile(200, __dirname + '/replies/otp_flow/post_create_session.json');
      nock(voterAuthorizerHost).post('/request_authorization')
        .replyWithFile(200, __dirname + '/replies/otp_flow/post_request_authorization.json');

      nock(OTPProviderHost).post('/authorize')
        .replyWithFile(200, __dirname + '/replies/otp_flow/post_authorize.json');

      nock(bulletinBoardHost).post('/test/app/register')
        .replyWithFile(200, __dirname + '/replies/otp_flow/post_test_app_register.json');
      nock(bulletinBoardHost).post('/test/app/challenge_empty_cryptograms')
        .replyWithFile(200, __dirname + '/replies/otp_flow/post_test_app_challenge_empty_cryptograms.json');
      nock(bulletinBoardHost).post('/test/app/get_commitment_opening')
        .replyWithFile(200, __dirname + '/replies/get_commitment_opening.valid.json');
      nock(bulletinBoardHost).get('/test/app/get_latest_board_hash')
        .replyWithFile(200, __dirname + '/replies/otp_flow/get_test_app_get_latest_board_hash.json');

      client = new AVClient('http://localhost:3000/test/app');
      await client.initialize()

      await client.requestAccessCode('voter123', 'voter@foo.bar');
      await client.validateAccessCode('1234');
      await client.registerVoter()

      const cvr = { '1': 'option1', '2': 'optiona' };
      await client.constructBallotCryptograms(cvr);

      client.generateTestCode();
      await client.spoilBallotCryptograms();

      nock.cleanAll();
      nock(bulletinBoardHost).get('/test/app/get_latest_board_hash')
        .replyWithFile(403, __dirname + '/replies/avx_error.invalid_2.json');

      const affidavit = Buffer.from('fake affidavit data').toString('base64');
      await expectError(
        client.submitBallotCryptograms(affidavit),
        Error,
        'Request failed with status code 403'
      );
    });
  });
});
