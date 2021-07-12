globalThis.TEST_MODE = true;

import { AVClient } from '../lib/av_client';
import { expect } from 'chai';
import nock = require('nock');

class StorageAdapter {
  private db: object;

  constructor() {
    this.db = {}
  }

  get(key: string) {
    return this.db[key];
  }

  set(key: string, value: any) {
    this.db[key] = value;
  }
}

describe('AVClient#encryptVotes', function() {
  let client;

  beforeEach(function() {
    const storage = new StorageAdapter();
    client = new AVClient(storage, 'http://localhost:3000/test/app');
  });

  context('encrypt vote', function() {
    beforeEach(function() {
      nock('http://localhost:3000/').get('/test/app/config')
        .replyWithFile(200, __dirname + '/replies/config.valid.json');
      nock('http://localhost:3000/').post('/test/app/sign_in')
        .replyWithFile(200, __dirname + '/replies/sign_in.valid.json');
      nock('http://localhost:3000/').post('/test/app/challenge_empty_cryptograms')
          .replyWithFile(200, __dirname + '/replies/challenge_empty_cryptograms.valid.json');
    });

    it('encrypts correctly', async function() {
      const validCodes = ['aAjEuD64Fo2143', '8beoTmFH13DCV3'];
      await client.authenticateWithCodes(validCodes);

      const contestSelections = {
        '1': 'option1',
        '2': 'optiona'
      };
      const contestCryptograms = {
        '1': '0244df49fde4a25cb25ccb03e5611b5f6301bf0eb804c8df5867cdc73f2ccc2ae3,026c36f1c60be44a4efd75d71b7c7fe6bd04d4e1247d97377ba692134bae858d0c',
        '2': '028168ab1e56f7cf8f7c652d7abeb3a8e1ede11f40d0faaee16d2e336328c813cf,02d85bfbb32b8140a99294c17adc719e42d960994b4fab70351fd8b6dc050b9676'
      };

      const cryptograms = client.encryptContestSelections(contestSelections);
      expect(cryptograms).to.deep.equal(contestCryptograms);
    });
  });
});
