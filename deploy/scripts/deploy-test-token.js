/**
 * Deploys a mintable TestERC20 and mints a balance to the deployer.
 *
 * Used to verify the confidential wrapper flow against an arbitrary ERC-20 on a chain
 * where no faucet token is available. Prints the address to feed to verify-fhe-erc20.
 *
 *   npx hardhat run scripts/deploy-test-token.js --network sepolia
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const Token = await hre.ethers.getContractFactory("TestERC20");
  const token = await Token.deploy("Arfhe Test USD", "tUSD", 6);
  await token.waitForDeployment();
  const address = await token.getAddress();
  console.log("TestERC20:", address);

  const mintTx = await token.mint(deployer.address, 1_000n * 10n ** 6n);
  await mintTx.wait();
  console.log("Minted 1000 tUSD to", deployer.address);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
