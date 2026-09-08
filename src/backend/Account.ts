import { Wallet, HDNodeWallet, Mnemonic, randomBytes } from "ethers";

export default class Account {
  name?: string | undefined;
  mnemonic?: Mnemonic | undefined;
  /**
   * Set when a stored account could not be rebuilt into a signing wallet.
   *
   * Such an account still shows its name and address — the user has funds there and hiding
   * the row would be worse — but it cannot sign, and must not be used as the parent for a
   * derived account.
   */
  rehydrationFailed?: boolean;

  private_key?: string | undefined;
  public_key?: string | undefined;
  address?: string | undefined;
  derivationPath?: string | undefined;

  ethers_wallet?: HDNodeWallet | Wallet | undefined;

  owned_tokens: Map<number, string[]>;

  constructor() {
    this.owned_tokens = new Map();
  }

  /**
   * Word counts this wallet will generate, and the entropy each one encodes.
   *
   * BIP-39 defines five lengths, but offering all of them asks the user to weigh a
   * distinction that does not exist in practice: 15, 18 and 21 words are longer to write
   * down without reaching a security level anyone can name. Twelve is what every wallet
   * defaults to; twenty-four is what people who want the larger seed come here asking for.
   */
  static readonly WORD_COUNT_ENTROPY: Readonly<Record<number, number>> = { 12: 16, 24: 32 };

  /**
   * A fresh recovery phrase, with no account attached to it.
   *
   * Separate from {@link Random} because showing someone a phrase and adding a wallet to
   * the running app are different commitments, and the creation flow needs the first
   * without the second. An account that exists from the moment the words are displayed is
   * a usable, password-less wallet for as long as the user is still reading them.
   *
   * @param wordCount 12 or 24. Anything else throws rather than quietly falling back — a
   *        wallet that hands back a shorter phrase than the one the user chose is a weaker
   *        seed than they believe they have, and they would never find out.
   */
  static GeneratePhrase(wordCount: number = 12): string {
    const entropyBytes = Account.WORD_COUNT_ENTROPY[wordCount];
    if (!entropyBytes) {
      throw new Error(`Unsupported recovery phrase length: ${wordCount}. Use 12 or 24.`);
    }

    // Built from entropy rather than HDNodeWallet.createRandom(), which is fixed at 16
    // bytes and so can only ever produce twelve words.
    return Mnemonic.fromEntropy(randomBytes(entropyBytes)).phrase;
  }

  static Random(name: string, wordCount: number = 12): Account {
    return Account.FromMnemonic(Account.GeneratePhrase(wordCount), name);
  }

  static FromMnemonic(phrase: string, name?: string, path: string = "m/44'/60'/0'/0/0"): Account {
    const account = new Account();

    account.ethers_wallet = HDNodeWallet.fromPhrase(phrase, "", path);
    account.mnemonic = account.ethers_wallet.mnemonic!;
    account.name = name ?? "";
    account.derivationPath = path;

    account.Init();
    return account;
  }

  static FromPrivateKey(privateKey: string, name: string): Account {
    const account = new Account();

    // Ensure the private key starts with '0x'
    const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    account.ethers_wallet = new Wallet(pk);
    account.name = name;

    // A raw private key doesn't have a mnemonic or derivation path
    account.mnemonic = undefined;
    account.derivationPath = undefined;

    account.Init();
    return account;
  }

  Init() {
    if (!this.ethers_wallet) {
      throw new Error("Account not initialized: ethers_wallet is missing");
    }

    this.private_key = this.ethers_wallet.privateKey;
    this.public_key = this.ethers_wallet.signingKey?.publicKey || (this.ethers_wallet as unknown as { publicKey?: string }).publicKey || "";
    this.address = this.ethers_wallet.address;
  }

  GetWords(): string[] | undefined {
    return this.mnemonic?.phrase.split(" ");
  }

  /*
    PUBLIC KEY != ADDRESS
    PUBLIC KEY != ADDRESS
    PUBLIC KEY != ADDRESS
  */
  GetPubKey(): string | undefined {
    return this.public_key;
  }

  GetPublicKey(): string | undefined {
    return this.GetPubKey();
  }

  GetAddress(): string | undefined {
    return this.address;
  }

  GetShortAddress(): string | undefined {
    const key = this.address?.toLowerCase();
    return key ? key.slice(0, 8) + "..." + key.slice(-6) : undefined;
  }

  SetName(name: string) {
    this.name = name;
  }

  GetName(): string {
    return this.name ?? "";
  }

  private getNetworkTokens(networkId: number): string[] {
    if (!this.owned_tokens.has(networkId)) {
      this.owned_tokens.set(networkId, []);
    }
    return this.owned_tokens.get(networkId)!;
  }

  AddToken(networkId: number, contractAddress: string): void {
    const addr = contractAddress.toLowerCase();
    const tokens = this.getNetworkTokens(networkId);
    if (!tokens.includes(addr)) {
      tokens.push(addr);
    }
  }

  RemoveToken(networkId: number, contractAddress: string): void {
    const addr = contractAddress.toLowerCase();
    const tokens = this.getNetworkTokens(networkId);
    this.owned_tokens.set(
      networkId,
      tokens.filter(t => t !== addr)
    );
  }

  HasToken(networkId: number, contractAddress: string): boolean {
    const addr = contractAddress.toLowerCase();
    return this.getNetworkTokens(networkId).includes(addr);
  }

  GetOwnedTokens(networkId: number): string[] {
    return [...this.getNetworkTokens(networkId)];
  }

  GetAllOwnedTokens(): Map<number, string[]> {
    return new Map(this.owned_tokens);
  }

  /**
   * Wipe all sensitive data from memory.
   * After calling this, the account is effectively "locked" —
   * only address and name remain for UI display purposes.
   * The account must be re-hydrated from encrypted storage to be usable again.
   */
  wipeKeys(): void {
    this.private_key = undefined;
    this.public_key = undefined;
    this.mnemonic = undefined;
    this.ethers_wallet = undefined;
  }
}
