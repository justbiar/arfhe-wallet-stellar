/**
 * Deploys the Arfhe confidential wrappers (ArfheShieldedETH + ArfheShieldedERC20)
 * to any CoFHE-supported testnet.
 *
 * CoFHE only supports Sepolia, Arbitrum Sepolia and Base Sepolia — deploying anywhere
 * else produces contracts whose FHE calls have no coprocessor behind them.
 *
 *   npx hardhat run scripts/deploy-shielded.js --network sepolia
 *   npx hardhat run scripts/deploy-shielded.js --network arbitrumSepolia
 *   npx hardhat run scripts/deploy-shielded.js --network baseSepolia
 *
 * Underlying token addresses are read from the repo-root .env so the deployed wrappers
 * always back the same tokens the wallet UI reads. Print output goes straight into .env.
 */
const hre = require("hardhat");

/** Underlying tokens per chain, plus the .env keys the resulting wrappers belong in. */
const TARGETS = {
  11155111: {
    name: "Sepolia",
    weth: process.env.VITE_SEPOLIA_WETH_ADDRESS || "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    usdc: process.env.VITE_SEPOLIA_USDC_ADDRESS,
    ethEnvKey: "VITE_WRAPPED_ETH_ADDRESS",
    usdcEnvKey: "VITE_WRAPPED_USDC_ADDRESS",
    factoryEnvKey: "VITE_WRAPPER_FACTORY_ADDRESS",
  },
  421614: {
    name: "Arbitrum Sepolia",
    weth: process.env.VITE_ARB_SEPOLIA_WETH_ADDRESS,
    usdc: process.env.VITE_ARB_SEPOLIA_USDC_ADDRESS,
    ethEnvKey: "VITE_ARB_WRAPPED_ETH_ADDRESS",
    usdcEnvKey: "VITE_ARB_WRAPPED_USDC_ADDRESS",
    factoryEnvKey: "VITE_ARB_WRAPPER_FACTORY_ADDRESS",
  },
  84532: {
    name: "Base Sepolia",
    weth: process.env.VITE_BASE_SEPOLIA_WETH_ADDRESS,
    usdc: process.env.VITE_BASE_SEPOLIA_USDC_ADDRESS,
    ethEnvKey: "VITE_BASE_WRAPPED_ETH_ADDRESS",
    usdcEnvKey: "VITE_BASE_WRAPPED_USDC_ADDRESS",
    factoryEnvKey: "VITE_BASE_WRAPPER_FACTORY_ADDRESS",
  },
};

async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const target = TARGETS[chainId];

  if (!target) {
    throw new Error(
      `Chain ${chainId} is not supported by CoFHE. Use sepolia (11155111), ` +
        `arbitrumSepolia (421614) or baseSepolia (84532).`
    );
  }
  if (!target.weth) throw new Error(`Missing WETH address for ${target.name} — set it in .env`);
  if (!target.usdc) throw new Error(`Missing USDC address for ${target.name} — set it in .env`);

  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log(`Network:  ${target.name} (${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${hre.ethers.formatEther(balance)} ETH`);

  // hardhat.config.js falls back to the private key 0x00…01 when DEPLOYER_PRIVATE_KEY
  // is unset. Without this check the failure reads as "no balance", which sends people
  // off to a faucet instead of to their .env.
  const PLACEHOLDER_DEPLOYER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
  if (deployer.address === PLACEHOLDER_DEPLOYER) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY is not set — hardhat is using its placeholder key.\n" +
        "Add DEPLOYER_PRIVATE_KEY=0x... to the repo-root .env (it is gitignored), then retry."
    );
  }

  if (balance === 0n) {
    throw new Error(`Deployer ${deployer.address} has no ${target.name} ETH — fund it before deploying.`);
  }

  console.log("\n--- ArfheShieldedETH (aeETH) ---");
  console.log(`WETH: ${target.weth}`);
  const ShieldedETH = await hre.ethers.getContractFactory("ArfheShieldedETH");
  const shieldedETH = await ShieldedETH.deploy(target.weth);
  await shieldedETH.waitForDeployment();
  const ethAddress = await shieldedETH.getAddress();
  console.log(`deployed: ${ethAddress}`);

  // The factory lets the wallet shield any standard ERC-20 on demand, instead of being
  // limited to the two wrappers deployed here.
  console.log("\n--- ArfheWrapperFactory ---");
  const Factory = await hre.ethers.getContractFactory("ArfheWrapperFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log(`deployed: ${factoryAddress}`);

  // USDC's wrapper is created *through* the factory, never standalone.
  //
  // Deploying it directly leaves it out of the registry, and the first user who presses
  // "Enable shielding" for USDC in the wallet makes the factory deploy a second one. Two
  // wrappers for one token split the backing pool: funds shielded through one cannot be
  // unshielded through the other, and both render as "aeUSDC" with no way to tell them
  // apart. The factory rejects duplicates, so routing through it is what keeps the
  // mapping "one underlying → one wrapper" true.
  console.log("\n--- aeUSDC (via factory) ---");
  console.log(`USDC: ${target.usdc}`);
  const createTx = await factory.createWrapper(target.usdc);
  await createTx.wait();

  // Some RPCs answer from pre-transaction state for a few seconds after the receipt.
  let usdcAddress = hre.ethers.ZeroAddress;
  for (let attempt = 0; usdcAddress === hre.ethers.ZeroAddress && attempt < 10; attempt++) {
    usdcAddress = await factory.wrapperFor(target.usdc);
    if (usdcAddress === hre.ethers.ZeroAddress) await new Promise((r) => setTimeout(r, 2000));
  }
  if (usdcAddress === hre.ethers.ZeroAddress) {
    throw new Error("createWrapper confirmed but the registry still reports no wrapper");
  }
  console.log(`deployed: ${usdcAddress} (registered in the factory)`);

  const shieldedUSDC = await hre.ethers.getContractAt("ArfheShieldedERC20", usdcAddress);

  // Read the conversion rates back so the operator can sanity-check decimal handling.
  const ethRate = await shieldedETH.rate();
  const usdcRate = await shieldedUSDC.rate();

  console.log("\n========================================");
  console.log(`DEPLOYMENT COMPLETE — ${target.name}`);
  console.log("========================================");
  console.log(`aeETH  rate: ${ethRate}  (confidential decimals: ${await shieldedETH.decimals()})`);
  console.log(`aeUSDC rate: ${usdcRate}  (confidential decimals: ${await shieldedUSDC.decimals()})`);
  console.log("\nAdd these to .env:");
  console.log(`${target.ethEnvKey}=${ethAddress}`);
  console.log(`${target.usdcEnvKey}=${usdcAddress}`);
  console.log(`${target.factoryEnvKey}=${factoryAddress}`);
  console.log("========================================");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
