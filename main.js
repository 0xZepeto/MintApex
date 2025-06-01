const ethers = require('ethers');
const chalk = require('chalk');
const fs = require('fs').promises;
const prompts = require('prompts');

// Fungsi untuk memuat konfigurasi
async function loadConfig() {
  try {
    const data = await fs.readFile('config.json', 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(chalk.red('Gagal memuat config.json:'), error.message);
    process.exit(1);
  }
}

// Fungsi untuk memuat RPC
async function loadRpcConfig() {
  try {
    const data = await fs.readFile('rpc.json', 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(chalk.red('Gagal memuat rpc.json:'), error.message);
    process.exit(1);
  }
}

// Fungsi untuk memuat private key
async function loadPrivateKeys() {
  try {
    const data = await fs.readFile('PrivateKeys.txt', 'utf8');
    return data.split('\n').map(key => key.trim()).filter(key => key);
  } catch (error) {
    console.error(chalk.red('Gagal memuat PrivateKeys.txt:'), error.message);
    process.exit(1);
  }
}

// Fungsi untuk memuat ABI
async function loadAbi(abiFile) {
  try {
    const data = await fs.readFile(abiFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(chalk.red(`Gagal memuat ${abiFile}:`), error.message);
    process.exit(1);
  }
}

// Fungsi untuk mendapatkan alamat kontrak via prompt
async function getContractAddress() {
  const response = await prompts({
    type: 'text',
    name: 'address',
    message: 'Masukkan alamat kontrak:',
    validate: value => ethers.utils.isAddress(value) ? true : 'Alamat kontrak tidak valid'
  });
  return response.address;
}

// Fungsi delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fungsi untuk mendapatkan gas price optimal
async function getOptimalGasPrice(provider, maxGasPrice) {
  try {
    const gasPrice = await provider.getGasPrice();
    return gasPrice > maxGasPrice ? maxGasPrice : gasPrice;
  } catch (error) {
    console.error(chalk.red('Gagal mengambil gas price, gunakan default:'), error.message);
    return maxGasPrice;
  }
}

// Fungsi untuk cek status mint
async function isMintActive(contract, config) {
  try {
    if (typeof contract.mintingStarted === 'function') {
      return await contract.mintingStarted();
    } else if (typeof contract.isPublicMintActive === 'function') {
      return await contract.isPublicMintActive();
    } else if (typeof contract.mintedTotal === 'function' && typeof contract.supply === 'function') {
      const phaseID = config.phaseID || ethers.constants.HashZero;
      const minted = await contract.mintedTotal(phaseID);
      const supply = await contract.supply();
      if (minted >= supply) {
        console.log(chalk.red(`Mint sudah selesai untuk phaseID: ${phaseID}. Cek phaseID di Blever!`));
      }
      return minted < supply;
    } else {
      console.log(chalk.yellow('Fungsi status mint tidak ditemukan, asumsikan aktif'));
      return true;
    }
  } catch (error) {
    console.error(chalk.red(`Gagal cek status mint. PhaseID (${config.phaseID}) mungkin salah: ${error.message}`));
    console.log(chalk.yellow('Cek phaseID di https://app.blever.xyz/drops/boggy atau @bleverxyz'));
    return false;
  }
}

// Fungsi untuk mint NFT
async function mintNfts(wallet, contract, walletAddress, config) {
  try {
    console.log(chalk.cyan(`Mencoba mint ${config.mintQuantity} NFT untuk wallet: ${walletAddress}`));

    // Siapkan parameter mint
    const params = config.mintParams.map(param => {
      if (param === 'to') return wallet.address;
      if (param === 'amount' || param === 'quantity') return config.mintQuantity;
      if (param === 'phaseID') return config.phaseID || ethers.constants.HashZero;
      if (param === 'price') return config.price || 0;
      if (param === 'maxPerTx') return config.maxPerTx || config.mintQuantity;
      if (param === 'maxPerUser') return config.maxPerUser || config.mintQuantity;
      if (param === 'maxPerPhase') return config.maxPerPhase || 10000;
      if (param === 'nonce') return config.nonce || ethers.constants.HashZero;
      if (param === 'signature') return config.signature || '0x';
      return param;
    });

    // Siapkan transaksi
    const tx = await contract.connect(wallet)[config.mintFunction](...params, {
      gasLimit: config.gasLimit,
      gasPrice: await getOptimalGasPrice(wallet.provider, ethers.utils.parseUnits(config.maxGasPriceGwei.toString(), 'gwei')),
      value: ethers.utils.parseEther(config.mintValue)
    });

    console.log(chalk.yellow(`Transaksi dikirim: ${tx.hash}`));
    const receipt = await tx.wait();
    console.log(chalk.green(`Mint berhasil untuk ${walletAddress}! Tx: ${receipt.transactionHash}`));
  } catch (error) {
    console.error(chalk.red(`Mint gagal untuk ${walletAddress}: ${error.message}`));
    if (error.message.includes('phaseID')) {
      console.log(chalk.yellow('PhaseID mungkin salah. Cek di https://app.blever.xyz/drops/boggy atau @bleverxyz'));
    }
  }
}

// Fungsi utama
async function main() {
  const config = await loadConfig();
  console.log(chalk.blue.bold(`=== Bot Auto-Mint NFT ApeChain: ${config.dropName} ===`));

  const contractAddress = await getContractAddress();
  const rpcConfig = await loadRpcConfig();
  const privateKeys = await loadPrivateKeys();
  const abi = await loadAbi(config.abiFile);

  console.log(chalk.blue(`Terhubung ke ApeChain: ${rpcConfig.rpcUrl}`));
  console.log(chalk.blue(`Kontrak NFT: ${contractAddress}`));
  console.log(chalk.blue(`Jumlah wallet: ${privateKeys.length}`));

  // Inisialisasi provider dan kontrak
  const provider = new ethers.providers.JsonRpcProvider(rpcConfig.rpcUrl);
  const contract = new ethers.Contract(contractAddress, abi, provider);

  // Cek status mint
  console.log(chalk.yellow('Mengecek status mint...'));
  let mintActive = await isMintActive(contract, config);

  if (!mintActive) {
    console.log(chalk.yellow('Mint belum dimulai. Memulai mode cek otomatis...'));
    while (!mintActive) {
      console.log(chalk.gray(`Menunggu ${config.checkIntervalMs / 1000} detik untuk cek ulang...`));
      await delay(config.checkIntervalMs);
      mintActive = await isMintActive(contract, config);
    }
    console.log(chalk.green('Mint sudah dimulai! Memulai proses minting...'));
  }

  // Loop untuk setiap wallet
  for (let i = 0; i < privateKeys.length; i++) {
    const privateKey = privateKeys[i];
    try {
      const wallet = new ethers.Wallet(privateKey, provider);
      console.log(chalk.magenta(`\nMemproses wallet ${i + 1}/${privateKeys.length}: ${wallet.address}`));

      // Cek saldo APE
      const balance = await provider.getBalance(wallet.address);
      if (balance.isZero()) {
        console.error(chalk.red(`Saldo APE kosong untuk ${wallet.address}, lewati...`));
        continue;
      }

      // Mint NFT
      await mintNfts(wallet, contract, wallet.address, config);

      // Delay untuk menghindari rate limit
      if (i < privateKeys.length - 1) {
        console.log(chalk.gray(`Menunggu ${config.delayMs}ms sebelum wallet berikutnya...`));
        await delay(config.delayMs);
      }
    } catch (error) {
      console.error(chalk.red(`Error pada wallet ${i + 1}: ${error.message}`));
    }
  }

  console.log(chalk.blue.bold('=== Selesai ==='));
}

// Jalankan bot
main().catch(error => {
  console.error(chalk.red('Error utama:'), error.message);
  process.exit(1);
});
