const Crypto = require('./aion_crypto.js')()
import { ContestIndexed, EncryptedVote } from './types'

type Affidavit = string

type SignAndSubmitArguments = {
  voterIdentifier: string;
  electionId: number;
  voteEncryptions: ContestIndexed<EncryptedVote>;
  privateKey: string;
  signatureKey: string,
  affidavit: Affidavit
}

export default class SubmitVotes {
  bulletinBoard: BulletinBoard;

  constructor(bulletinBoard: BulletinBoard) {
    this.bulletinBoard = bulletinBoard;
  }

  async signAndSubmitVotes({ voterIdentifier, electionId, voteEncryptions, privateKey, signatureKey, affidavit }: SignAndSubmitArguments) {
    const acknowledgeResponse = await this.acknowledge()

    const votes = {}
    const cryptogramsWithProofs = {}
    for (let contestId in voteEncryptions) {
      votes[contestId] = voteEncryptions[contestId].cryptogram
      cryptogramsWithProofs[contestId] = {
        cryptogram: voteEncryptions[contestId].cryptogram,
        proof: voteEncryptions[contestId].proof
      }
    }

    const content = {
      acknowledged_at: acknowledgeResponse.currentTime,
      acknowledged_board_hash: acknowledgeResponse.currentBoardHash,
      election_id: electionId,
      voter_identifier: voterIdentifier,
      votes
    };

    const contentString = JSON.stringify(content)
    const contentHash = Crypto.hashString(contentString)
    const voterSignature = this.sign(contentHash, privateKey)

    const receipt = await this.submit({ contentHash, voterSignature, cryptogramsWithProofs })
    await this.verifyReceipt({ contentHash, voterSignature, receipt, signatureKey });

    return receipt
  }

  private async submit({ contentHash, voterSignature, cryptogramsWithProofs }) {
    const { data } = await this.bulletinBoard.submitVotes(contentHash, voterSignature, cryptogramsWithProofs)

    if (data.error) {
      return Promise.reject(data.error.description)
    }

    const receipt = {
      previousBoardHash: data.previousBoardHash,
      boardHash: data.boardHash,
      registeredAt: data.registeredAt,
      serverSignature: data.serverSignature,
      voteSubmissionId: data.voteSubmissionId
    }

    return receipt
  }

  private async acknowledge() {
    const { data } = await this.bulletinBoard.getBoardHash()

    if (!data.currentBoardHash || !data.currentTime) {
      return Promise.reject('Could not get latest board hash');
    }

    const acknowledgedBoard = {
      currentBoardHash: data.currentBoardHash,
      currentTime: data.currentTime
    }
    return acknowledgedBoard
  }

  private sign(contentHash: HashValue, privateKey: PrivateKey) {
    const signature = Crypto.generateSchnorrSignature(contentHash, privateKey)
    return signature
  }

  private async verifyReceipt({ contentHash, voterSignature, receipt, signatureKey }) {
    // verify board hash computation
    const boardHashObject = {
      content_hash: contentHash,
      previous_board_hash: receipt.previousBoardHash,
      registered_at: receipt.registeredAt
    }
    const boardHashString = JSON.stringify(boardHashObject)
    const computedBoardHash = Crypto.hashString(boardHashString)

    if (computedBoardHash != receipt.boardHash) {
      return Promise.reject('Invalid vote receipt: corrupt board hash')
    }

    // verify server signature
    const receiptHashObject = {
      board_hash: receipt.boardHash,
      signature: voterSignature
    }
    const receiptHashString = JSON.stringify(receiptHashObject)
    const receiptHash = Crypto.hashString(receiptHashString)

    if (!Crypto.verifySchnorrSignature(receipt.serverSignature, receiptHash, signatureKey)) {
      return Promise.reject('Invalid vote receipt: corrupt server signature')
    }

    return Promise.resolve()
  }

}

interface BulletinBoard {
  getBoardHash: () => any;
  submitVotes: (contentHash: HashValue, signature: Signature, cryptogramsWithProofs: ContestIndexed<CryptogramWithProof>) => any
}

type CryptogramWithProof = {
  cryptogram: Cryptogram;
  proof: Proof;
}

type Proof = string
type Cryptogram = string
type Signature = string;
type PrivateKey = string
type HashValue = string;

type AcknowledgedBoard = {
  currentBoardHash: HashValue;
  currentTime: string;
}

type VoteReceipt = {
  previousBoardHash: HashValue;
  boardHash: HashValue;
  registeredAt: string;
  serverSignature: Signature
}
