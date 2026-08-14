/**
 * An NFT an address actually owns.
 *
 * The token id is the part that matters: without it the wallet cannot fetch the right
 * artwork, cannot link to the item on a marketplace, and cannot tell two tokens of the
 * same collection apart.
 */
export interface OwnedNftItem {
  contractAddress: string;
  tokenId: string;
  name: string;
  symbol: string;
  /** Resolved image URL, already normalised away from ipfs:// by the indexer. */
  imageUrl: string;
  /** How many of this token id the address holds (>1 only for ERC-1155). */
  balance: string;
  tokenType?: string;
}
