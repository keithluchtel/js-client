import { BulletinBoard } from './av_client/connectors/bulletin_board';
import { fetchElectionConfig, ElectionConfig, validateElectionConfig } from './av_client/election_config';
import { ContestMap, OpenableEnvelope, EmptyCryptogram, BallotBoxReceipt } from './av_client/types'
import AuthenticateWithCodes from './av_client/authenticate_with_codes';
import { registerVoter } from './av_client/register_voter';
import EncryptVotes from './av_client/encrypt_votes';
import SubmitVotes from './av_client/submit_votes';
import VoterAuthorizationCoordinator from './av_client/connectors/voter_authorization_coordinator';
import { OTPProvider, IdentityConfirmationToken } from "./av_client/connectors/otp_provider";
import {
  AccessCodeExpired,
  AccessCodeInvalid,
  BulletinBoardError,
  CorruptCvrError,
  EmailDoesNotMatchVoterRecordError,
  InvalidConfigError,
  InvalidStateError,
  NetworkError } from './av_client/errors'
import { KeyPair, CastVoteRecord, Affidavit } from './av_client/types';
import { validateCvr } from './av_client/cvr_validation';
import { randomKeyPair} from './av_client/generate_key_pair';

/** @internal */
export const sjcl = require('./av_client/sjcl');

/**
 * # Assembly Voting Client API.
 *
 * The API is responsible for handling all the cryptographic operations and all network communication with:
 * * the Digital Ballot Box
 * * the Voter Authorization Coordinator service
 * * the OTP provider(s)
 *
 * ## Expected sequence of methods being executed
 *
 * |Method                                                                    | Description |
 * -------------------------------------------------------------------------- | ---
 * |{@link AVClient.initialize | initialize }                                 | Initializes the library by fetching election configuration |
 * |{@link AVClient.requestAccessCode | requestAccessCode }                   | Initiates the authorization process, in case voter has not authorized yet. Requests access code to be sent to voter email |
 * |{@link AVClient.validateAccessCode | validateAccessCode }                 | Gets voter authorized to vote. |
 * |{@link AVClient.registerVoter | registerVoter }                           | Registers the voter on the bulletin board |
 * |{@link AVClient.constructBallotCryptograms | constructBallotCryptograms } | Constructs voter ballot cryptograms. |
 * |{@link AVClient.spoilBallotCryptograms | spoilBallotCryptograms }         | Optional. Initiates process of testing the ballot encryption. |
 * |{@link AVClient.submitBallotCryptograms | submitBallotCryptograms }       | Finalizes the voting process. |
 * |{@link AVClient.purgeData | purgeData }                                   | Optional. Explicitly purges internal data. |
 *
 * ## Example walkthrough test
 *
 * ```typescript
 * [[include:readme_example.test.ts]]
 * ```
 */

export class AVClient {
  private authorizationSessionId: string;
  private email: string;
  private identityConfirmationToken: IdentityConfirmationToken;

  private bulletinBoard: BulletinBoard;
  private electionConfig?: ElectionConfig;
  private emptyCryptograms: ContestMap<EmptyCryptogram>;
  private keyPair: KeyPair;
  private testCode: string;
  private voteEncryptions: ContestMap<OpenableEnvelope>;
  private voterIdentifier: string;
  private contestIds: number[];

  /**
   * @param bulletinBoardURL URL to the Assembly Voting backend server, specific for election.
   */
  constructor(bulletinBoardURL: string) {
    this.bulletinBoard = new BulletinBoard(bulletinBoardURL);
  }

  /**
   * Initializes the client with an election config.
   * If no config is provided, it fetches one from the backend.
   *
   * @param electionConfig Allows injection of an election configuration for testing purposes
   * @returns Returns undefined if succeeded or throws an error
   * @throws {@link NetworkError | NetworkError } if any request failed to get a response
   */
  async initialize(electionConfig: ElectionConfig): Promise<void>
  async initialize(): Promise<void>
  public async initialize(electionConfig?: ElectionConfig): Promise<void> {
    if (!electionConfig) {
      electionConfig = await fetchElectionConfig(this.bulletinBoard);
    }

    validateElectionConfig(electionConfig);
    this.electionConfig = electionConfig;
  }

  /**
   * Returns voter authorization mode from the election configuration.
   *
   * @internal
   * @returns Returns an object with the method name, and the reference to the function.
   * Available method names are
   * * {@link AVClient.authenticateWithCodes | authenticateWithCodes} for authentication via election codes.
   * * {@link AVClient.requestAccessCode | requestAccessCode} for authorization via OTPs.
   * @throws {@link InvalidConfigError | InvalidConfigError } if the config does not specify a supported authorizationMode
   */
  public getAuthorizationMethod(): { methodName: string; method: Function } {
    switch(this.getElectionConfig().authorizationMode) {
      case 'election codes':
        return {
          methodName: 'authenticateWithCodes',
          method: this.authenticateWithCodes
        }
      case 'otps':
        return {
          methodName: 'requestAccessCode',
          method: this.requestAccessCode
        }
      default:
        throw new InvalidConfigError('Authorization method not found in election config')
    }
  }

  /**
   * Should only be used when election authorization mode is 'election codes'.
   *
   * Authenticates or rejects voter, based on their submitted election codes.
   *
   * @internal
   * @param   codes Array of election code strings.
   * @returns Returns undefined if authentication succeeded or throws an error
   */
  public async authenticateWithCodes(codes: string[]): Promise<void> {
    const authenticationResponse = await new AuthenticateWithCodes(this.bulletinBoard)
      .authenticate(codes, this.electionId(), this.electionEncryptionKey());

    this.voterIdentifier = authenticationResponse.voterIdentifier;
    this.keyPair = authenticationResponse.keyPair;
    this.emptyCryptograms = authenticationResponse.emptyCryptograms;
  }

  /**
   * Should be called when a voter chooses digital vote submission (instead of mail-in).
   *
   * Will attempt to get backend services to send an access code (one time password, OTP) to voter's email address.
   *
   * Should be followed by {@link AVClient.validateAccessCode | validateAccessCode} to submit access code for validation.
   *
   * @param opaqueVoterId Voter ID that preserves voter anonymity.
   * @param email where the voter expects to receive otp code.
   * @returns Returns undefined or throws an error.
   * @throws VoterRecordNotFound if no voter was found
   * @throws {@link NetworkError | NetworkError } if any request failed to get a response
   */
  public async requestAccessCode(opaqueVoterId: string, email: string): Promise<void> {
    const coordinatorURL = this.getElectionConfig().services.voter_authorizer.url;
    const coordinator = new VoterAuthorizationCoordinator(coordinatorURL);

    return coordinator.createSession(opaqueVoterId, email)
      .then(({ data: { sessionId } }) => {
        return sessionId
      })
      .then(async sessionId => {
        this.authorizationSessionId = sessionId
        this.email = email
      });
  }

  /**
   * Should be called after {@link AVClient.requestAccessCode | requestAccessCode}.
   *
   * Takes an access code (OTP) that voter received, uses it to authorize to submit votes.
   *
   * Internally, generates a private/public key pair, then attempts to authorize the public
   * key with each OTP provider.
   *
   * Should be followed by {@link AVClient.constructBallotCryptograms | constructBallotCryptograms}.
   *
   * @param   code An access code string.
   * @param   email Voter email.
   * @returns Returns undefined if authorization succeeded or throws an error
   * @throws {@link InvalidStateError | InvalidStateError } if called before required data is available
   * @throws {@link AccessCodeExpired | AccessCodeExpired } if an OTP code has expired
   * @throws {@link AccessCodeInvalid | AccessCodeInvalid } if an OTP code is invalid
   * @throws {@link NetworkError | NetworkError } if any request failed to get a response
   */
  async validateAccessCode(code: string): Promise<void> {
    if(!this.email)
      throw new InvalidStateError('Cannot validate access code. Access code was not requested.');

    const provider = new OTPProvider(this.getElectionConfig().services.otp_provider.url)
    
    this.identityConfirmationToken = await provider.requestOTPAuthorization(code, this.email);
  }


  /**
   * Registers a voter
   *
   * @returns undefined or throws an error
   */
  public async registerVoter(): Promise<void> {
    if(!this.identityConfirmationToken)
      throw new InvalidStateError('Cannot register voter without identity confirmation. User has not validated access code.')

    this.keyPair = randomKeyPair();

    const coordinatorURL = this.getElectionConfig().services.voter_authorizer.url;
    const coordinator = new VoterAuthorizationCoordinator(coordinatorURL);

    const authorizationResponse = await coordinator.requestPublicKeyAuthorization(
      this.authorizationSessionId,
      this.identityConfirmationToken,
      this.keyPair.publicKey
    )

    const { registrationToken, publicKeyToken } = authorizationResponse.data

    const registerVoterResponse = await registerVoter(this.bulletinBoard, this.keyPair, this.getElectionConfig().encryptionKey, registrationToken, publicKeyToken)

    this.voterIdentifier = registerVoterResponse.voterIdentifier
    this.emptyCryptograms = registerVoterResponse.emptyCryptograms
    this.contestIds = registerVoterResponse.contestIds
  }

  /**
   * Should be called after {@link AVClient.validateAccessCode | validateAccessCode}.
   *
   * Encrypts a {@link CastVoteRecord | cast-vote-record} (CVR) and generates vote cryptograms.
   *
   * Example:
   * ```javascript
   * const client = new AVClient(url);
   * const cvr = { '1': 'option1', '2': 'optiona' };
   * const trackingCode = await client.constructBallotCryptograms(cvr);
   * ```
   *
   * Where `'1'` and `'2'` are contest ids, and `'option1'` and `'optiona'` are
   * values internal to the AV election config.
   *
   * Should be followed by either {@link AVClient.spoilBallotCryptograms | spoilBallotCryptograms}
   * or {@link AVClient.submitBallotCryptograms | submitBallotCryptograms}.
   *
   * @param   cvr Object containing the selections for each contest.
   * @returns Returns the ballot tracking code. Example:
   * ```javascript
   * '5e4d8fe41fa3819cc064e2ace0eda8a847fe322594a6fd5a9a51c699e63804b7'
   * ```
   * @throws {@link InvalidStateError | InvalidStateError } if called before required data is available
   * @throws {@link CorruptCvrError | CorruptCvrError } if the cast vote record is invalid
   * @throws {@link NetworkError | NetworkError } if any request failed to get a response
   */
  public async constructBallotCryptograms(cvr: CastVoteRecord): Promise<string> {
    if(!(this.voterIdentifier || this.emptyCryptograms || this.contestIds)) {
      throw new InvalidStateError('Cannot construct ballot cryptograms. Voter registration not completed successfully')
    }

    const contests = this.getElectionConfig().ballots

    switch(validateCvr(cvr, contests)) {
      case ":invalid_contest": throw new CorruptCvrError('Corrupt CVR: Contains invalid contest');
      case ":invalid_option": throw new CorruptCvrError('Corrupt CVR: Contains invalid option');
      case ":okay":
    }

    const emptyCryptograms = Object.fromEntries(Object.keys(cvr).map((contestId) => [contestId, this.emptyCryptograms[contestId].empty_cryptogram ]))
    const contestEncodingTypes = Object.fromEntries(Object.keys(cvr).map((contestId) => {
      const contest = contests.find(b => b.id.toString() == contestId)

      // We can use non-null assertion for contest because selections have been validated
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return [contestId, contest!.vote_encoding_type];
    }))

    const envelopes = EncryptVotes.encrypt(
      cvr,
      emptyCryptograms,
      contestEncodingTypes,
      this.electionEncryptionKey()
    );

    const trackingCode = EncryptVotes.fingerprint(this.extractCryptograms(envelopes));

    this.voteEncryptions = envelopes

    return trackingCode;
  }

  /**
   * Should be called after {@link AVClient.validateAccessCode | validateAccessCode}.
   * Should be called before {@link AVClient.spoilBallotCryptograms | spoilBallotCryptograms}.
   *
   * Generates an encryption key that is used to add another encryption layer to vote cryptograms when they are spoiled.
   *
   * The generateTestCode is used in case {@link AVClient.spoilBallotCryptograms | spoilBallotCryptograms} is called afterwards.
   *
   * @returns Returns the test code. Example:
   * ```javascript
   * '5e4d8fe41fa3819cc064e2ace0eda8a847fe322594a6fd5a9a51c699e63804b7'
   * ```
   */
  public generateTestCode(): void {
    this.testCode = EncryptVotes.generateTestCode()
  }

  /**
   * Should be called when voter chooses to test the encryption of their ballot.
   * Gets commitment opening of the digital ballot box and validates it.
   *
   * @returns Returns undefined if the validation succeeds or throws an error
   * @throws {@link InvalidStateError | InvalidStateError } if called before required data is available
   * @throws ServerCommitmentError if the server commitment is invalid
   * @throws {@link NetworkError | NetworkError } if any request failed to get a response
   */
  public async spoilBallotCryptograms(): Promise<void> {
    // TODO: encrypt the vote cryptograms one more time with a key derived from `this.generateTestCode`.
    //  A key is derived like: key = hash(test code, ballot id, cryptogram index)
    // TODO: compute commitment openings of the voter commitment
    // TODO: call the bulletin board to spoil the cryptograms. Send the encrypted vote cryptograms and voter commitment
    //  opening. Response contains server commitment openings.
    // TODO: verify the server commitment openings against server commitment and server empty cryptograms

    throw new Error('Not implemented yet');
  }

  /**
   * Should be the last call in the entire voting process.
   *
   * Submits encrypted ballot and the affidavit to the digital ballot box.
   *
   *
   * @param affidavit The {@link Affidavit | affidavit} document.
   * @return Returns the vote receipt. Example of a receipt:
   * ```javascript
   * {
   *    previousBoardHash: 'd8d9742271592d1b212bbd4cbbbe357aef8e00cdbdf312df95e9cf9a1a921465',
   *    boardHash: '5a9175c2b3617298d78be7d0244a68f34bc8b2a37061bb4d3fdf97edc1424098',
   *    registeredAt: '2020-03-01T10:00:00.000+01:00',
   *    serverSignature: 'dbcce518142b8740a5c911f727f3c02829211a8ddfccabeb89297877e4198bc1,46826ddfccaac9ca105e39c8a2d015098479624c411b4783ca1a3600daf4e8fa',
   *    voteSubmissionId: 6
      }
   * ```
   * @throws {@link NetworkError | NetworkError } if any request failed to get a response
   */
  public async submitBallotCryptograms(affidavit: Affidavit): Promise<BallotBoxReceipt> {
    if(!(this.voterIdentifier || this.voteEncryptions)) {
      throw new InvalidStateError('Cannot submit cryptograms. Voter identity unknown or no open envelopes')
    }

    const voterIdentifier = this.voterIdentifier
    const electionId = this.electionId()
    const encryptedVotes = this.voteEncryptions
    const voterPrivateKey = this.privateKey();
    const electionSigningPublicKey = this.electionSigningPublicKey();
    const affidavitConfig = this.affidavitConfig();

    const votesSubmitter = new SubmitVotes(this.bulletinBoard)
    const encryptedAffidavit = votesSubmitter.encryptAffidavit(
      affidavit,
      affidavitConfig
    )

    return await votesSubmitter.signAndSubmitVotes({
        voterIdentifier,
        electionId,
        encryptedVotes,
        voterPrivateKey,
        electionSigningPublicKey,
        encryptedAffidavit
    });
  }

  /**
   * Purges internal data.
   */
  public purgeData(): void {
    // TODO: implement me
    return
  }

  /**
   * Returns data for rendering the list of cryptograms of the ballot
   * @param Map of openable envelopes with cryptograms
   * @return Object containing a cryptogram for each contest
   */
  private extractCryptograms(envelopes: ContestMap<OpenableEnvelope>): ContestMap<Cryptogram> {
    return Object.fromEntries(Object.keys(envelopes).map(contestId =>  [contestId, envelopes[contestId].cryptogram ]))
  }


  public getElectionConfig(): ElectionConfig {
    if(!this.electionConfig){
      throw new InvalidStateError('No configuration loaded. Did you call initialize()?')
    }

    return this.electionConfig
  }

  private electionId(): number {
    return this.getElectionConfig().election.id;
  }

  private electionEncryptionKey(): ECPoint {
    return this.getElectionConfig().encryptionKey
  }

  private electionSigningPublicKey(): ECPoint {
    return this.getElectionConfig().signingPublicKey
  }

  private affidavitConfig(): AffidavitConfig {
    return this.getElectionConfig().affidavit
  }

  private privateKey(): BigNum {
    return this.keyPair.privateKey
  }

  private publicKey(): ECPoint {
    return this.keyPair.publicKey
  }
}

type BigNum = string;
type ECPoint = string;
type Cryptogram = string;

type AffidavitConfig = {
  curve: string;
  encryptionKey: string;
}

export type { CastVoteRecord, Affidavit, BallotBoxReceipt }

export type {
  AccessCodeExpired,
  AccessCodeInvalid,
  BulletinBoardError,
  CorruptCvrError,
  EmailDoesNotMatchVoterRecordError,
  InvalidConfigError,
  InvalidStateError,
  NetworkError
}
