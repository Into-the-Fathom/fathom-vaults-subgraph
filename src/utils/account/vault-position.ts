import { Address, BigInt, log } from '@graphprotocol/graph-ts';
import {
  Account,
  AccountVaultPosition,
  AccountVaultPositionUpdate,
  Token,
  Transaction,
  Vault,
} from '../../../generated/schema';
import { VaultPackage } from '../../../generated/templates/FathomVault/VaultPackage';
import * as vaultPositionUpdateLibrary from './vault-position-update';
import { BIGINT_ZERO, ZERO_ADDRESS } from '../constants';

export function buildId(account: Account, vault: Vault): string {
  return account.id.concat('-').concat(vault.id);
}

export function getOrCreate(
  account: Account,
  vault: Vault,
  balanceShares: BigInt,
  balanceTokens: BigInt,
  balancePosition: BigInt,
  balanceProfit: BigInt,
  latestUpdateId: string,
  transaction: Transaction
): AccountVaultPosition {
  let txHash = transaction.hash.toHexString();
  log.info(
    '[AccountVaultPosition-getOrCreate] Getting account {} vault {} position. TX: {} Balance Tokens: {}',
    [account.id, vault.id, txHash, balanceTokens.toString()]
  );
  let id = buildId(account, vault);
  let accountVaultPosition = AccountVaultPosition.load(id);
  if (accountVaultPosition == null) {
    log.debug(
      '[AccountVaultPosition-getOrCreate] Not found. Creating account {} vault {} position. TX: {}',
      [account.id, vault.id, txHash]
    );
    accountVaultPosition = new AccountVaultPosition(id);
    accountVaultPosition.vault = vault.id;
    accountVaultPosition.account = account.id;
    accountVaultPosition.token = vault.token;
    accountVaultPosition.shareToken = vault.shareToken;
    accountVaultPosition.transaction = transaction.id;
    accountVaultPosition.balanceTokens = balanceTokens;
    accountVaultPosition.balanceShares = balanceShares;
    accountVaultPosition.balancePosition = balancePosition;
    accountVaultPosition.balanceProfit = balanceProfit;
    accountVaultPosition.latestUpdate = latestUpdateId;
    accountVaultPosition.save();
  } else {
    log.debug(
      '[AccountVaultPosition-getOrCreate] Found. Returning account {} vault {} position id {}. TX: {}',
      [account.id, vault.id, txHash]
    );
  }
  return accountVaultPosition as AccountVaultPosition;
}

export function getBalancePosition(
  account: Account,
  vaultContract: VaultPackage
): BigInt {
  log.info('[VaultPosition] GetBalancePosition account  {} ', [account.id]);
  let pricePerShare = vaultContract.pricePerShare();
  let decimals = vaultContract.decimals();
  // (vault.balanceOf(account) * (vault.pricePerShare() / 10**vault.decimals()))
  let balanceShares = vaultContract.balanceOf(Address.fromString(account.id));
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let u8Decimals = u8(decimals);
  let divisor = BigInt.fromI32(10).pow(u8Decimals);
  return balanceShares.times(pricePerShare).div(divisor);
}

export class VaultPositionResponse {
  public accountVaultPosition: AccountVaultPosition;
  public accountVaultPositionUpdate: AccountVaultPositionUpdate;
  constructor(
    accountVaultPosition: AccountVaultPosition,
    accountVaultPositionUpdate: AccountVaultPositionUpdate
  ) {
    this.accountVaultPosition = accountVaultPosition;
    this.accountVaultPositionUpdate = accountVaultPositionUpdate;
  }
  static fromValue(
    accountVaultPosition: AccountVaultPosition,
    accountVaultPositionUpdate: AccountVaultPositionUpdate
  ): VaultPositionResponse {
    return new VaultPositionResponse(
      accountVaultPosition,
      accountVaultPositionUpdate
    );
  }
}

function getBalanceTokens(current: BigInt, withdraw: BigInt): BigInt {
  return withdraw.gt(current) ? BIGINT_ZERO : current.minus(withdraw);
}

function getBalanceProfit(
  currentSharesBalance: BigInt,
  currentProfit: BigInt,
  currentAmount: BigInt,
  withdrawAmount: BigInt
): BigInt {
  if (currentSharesBalance.isZero()) {
    // User withdrawn all the shares, so we can calculate the profit or losses.
    if (withdrawAmount.gt(currentAmount)) {
      // User has profits.
      return currentProfit.plus(withdrawAmount.minus(currentAmount));
    } else if (withdrawAmount.lt(currentAmount)) {
      // User has losses.
      return currentProfit.minus(currentAmount.minus(withdrawAmount));
    } else {
      // User has no profits or losses.
      return currentProfit;
    }
  }
  // User still have shares, so we returns the current profit.
  return currentProfit;
}

export function deposit(
  vaultContract: VaultPackage,
  account: Account,
  vault: Vault,
  transaction: Transaction,
  depositedTokens: BigInt,
  receivedShares: BigInt
): VaultPositionResponse {
  log.debug('[VaultPosition] Deposit', []);
  // TODO Use getOrCreate function
  let vaultPositionId = buildId(account, vault);
  let txHash = transaction.hash.toHexString();
  let accountVaultPosition = AccountVaultPosition.load(vaultPositionId);
  let accountVaultPositionUpdate: AccountVaultPositionUpdate;
  // TODO Use tokenLibrary.getOrCreate
  let token = Token.load(vault.token) as Token;
  let balanceShares = vaultContract.balanceOf(Address.fromString(account.id));
  let balancePosition = getBalancePosition(account, vaultContract);
  if (accountVaultPosition == null) {
    log.info('Tx: {} Account vault position {} not found. Creating it.', [
      txHash,
      vaultPositionId,
    ]);
    accountVaultPosition = new AccountVaultPosition(vaultPositionId);
    accountVaultPosition.vault = vault.id;
    accountVaultPosition.account = account.id;
    accountVaultPosition.token = vault.token;
    accountVaultPosition.shareToken = vault.shareToken;
    accountVaultPosition.transaction = transaction.id;
    accountVaultPosition.balanceTokens = depositedTokens;
    accountVaultPosition.balanceShares = balanceShares;
    accountVaultPosition.balanceProfit = BIGINT_ZERO;
    accountVaultPositionUpdate = vaultPositionUpdateLibrary.createFirst(
      account,
      vault,
      vaultPositionId,
      BIGINT_ZERO,
      transaction,
      depositedTokens,
      receivedShares,
      balanceShares,
      balancePosition
    );

    accountVaultPosition.balancePosition = balancePosition;
    accountVaultPosition.latestUpdate = accountVaultPositionUpdate.id;
    accountVaultPosition.save();
  } else {
    log.info('Tx: {} Account vault position {} found. Using it.', [
      txHash,
      vaultPositionId,
    ]);

    // Assuming accountVaultPosition.latestUpdate is a string of concatenated hashes separated by '-'
    let updatesParts = accountVaultPosition.latestUpdate.split('-');
    let thirdElementOfUpdate: string | null;

    // Check if the updatesParts array has more than two elements
    if (updatesParts.length > 2) {
      thirdElementOfUpdate = updatesParts[2]; // Get the third element
    } else {
      thirdElementOfUpdate = null; // Set to null if there aren't enough parts
    }

    // AssemblyScript does not handle 'null' the same way, so we check for null before proceeding
    if (thirdElementOfUpdate != null && thirdElementOfUpdate != txHash) {
      // If they are different, proceed with updating the accountVaultPosition
      accountVaultPosition.balanceTokens = accountVaultPosition.balanceTokens.plus(depositedTokens);
      accountVaultPosition.balanceShares = balanceShares;
      accountVaultPositionUpdate = vaultPositionUpdateLibrary.deposit(
        account,
        vault,
        vaultPositionId,
        accountVaultPosition.latestUpdate,
        transaction,
        depositedTokens,
        receivedShares,
        balanceShares,
        balancePosition
      );

      accountVaultPosition.balancePosition = balancePosition;
      accountVaultPosition.latestUpdate = accountVaultPositionUpdate.id;
      accountVaultPosition.save();

    } else {
      // If they are the same, log the event and do not update
      log.info('Tx: {} has already been processed. Skipping.', [txHash]);
    }
  }

  return VaultPositionResponse.fromValue(
    accountVaultPosition as AccountVaultPosition,
    accountVaultPositionUpdate
  );
}

export function withdraw(
  vaultContract: VaultPackage,
  accountVaultPosition: AccountVaultPosition,
  withdrawnAmount: BigInt,
  sharesBurnt: BigInt,
  transaction: Transaction
): AccountVaultPositionUpdate | null {
  let txHash = transaction.hash.toHexString();
  let account = Account.load(accountVaultPosition.account) as Account;
  let vault = Vault.load(accountVaultPosition.vault) as Vault;
  let token = Token.load(vault.token) as Token;
  let balanceShares = vaultContract.balanceOf(Address.fromString(account.id));
  let balancePosition = getBalancePosition(account, vaultContract);
  let newAccountVaultPositionOrder = vaultPositionUpdateLibrary.getNewOrder(
    accountVaultPosition.latestUpdate,
    transaction.hash.toHexString()
  );
  let newAccountVaultPositionUpdate: AccountVaultPositionUpdate | null;
  let accountVaultPositionUpdateId = vaultPositionUpdateLibrary.buildIdFromAccountVaultAndOrder(
    account,
    vault,
    transaction.hash.toHexString(),
    newAccountVaultPositionOrder
  );

  // Assuming accountVaultPosition.latestUpdate is a string of concatenated hashes separated by '-'
  let updatesParts = accountVaultPosition.latestUpdate.split('-');
  let thirdElementOfUpdate: string | null;

  // Check if the updatesParts array has more than two elements
  if (updatesParts.length > 2) {
    thirdElementOfUpdate = updatesParts[2]; // Get the third element
  } else {
    thirdElementOfUpdate = null; // Set to null if there aren't enough parts
  }

  // AssemblyScript does not handle 'null' the same way, so we check for null before proceeding
  if (thirdElementOfUpdate != null && thirdElementOfUpdate != txHash) {
    // If they are different, proceed with updating the accountVaultPosition
    newAccountVaultPositionUpdate = vaultPositionUpdateLibrary.createAccountVaultPositionUpdate(
      accountVaultPositionUpdateId,
      newAccountVaultPositionOrder,
      account,
      vault,
      accountVaultPosition.id,
      transaction,
      BIGINT_ZERO, // deposits
      withdrawnAmount,
      BIGINT_ZERO, // sharesMinted
      sharesBurnt,
      BIGINT_ZERO, // sharesSent
      BIGINT_ZERO, // sharesReceived
      BIGINT_ZERO, // tokensSent
      BIGINT_ZERO, // tokensReceived,
      balanceShares,
      balancePosition
    );
    accountVaultPosition.balanceShares = balanceShares;
    accountVaultPosition.balanceTokens = getBalanceTokens(
      accountVaultPosition.balanceTokens,
      withdrawnAmount
    );
    accountVaultPosition.balanceProfit = getBalanceProfit(
      accountVaultPosition.balanceShares,
      accountVaultPosition.balanceProfit,
      accountVaultPosition.balanceTokens,
      withdrawnAmount
    );
    accountVaultPosition.balancePosition = balancePosition;
    accountVaultPosition.latestUpdate = newAccountVaultPositionUpdate.id;
    accountVaultPosition.save();

  } else {
    // If they are the same, log the event and do not update
    log.info('Tx: {} has already been processed. Skipping.', [txHash]);
    newAccountVaultPositionUpdate = AccountVaultPositionUpdate.load(accountVaultPositionUpdateId);
  }

  
  return newAccountVaultPositionUpdate;
}

export function withdrawZero(
  account: Account,
  vault: Vault,
  transaction: Transaction
): AccountVaultPositionUpdate {
  let newAccountVaultPositionOrder = BIGINT_ZERO;
  let accountVaultPositionUpdateId = vaultPositionUpdateLibrary.buildIdFromAccountVaultAndOrder(
    account,
    vault,
    transaction.hash.toHexString(),
    newAccountVaultPositionOrder
  );
  let accountVaultPosition = getOrCreate(
    account,
    vault,
    BIGINT_ZERO,
    BIGINT_ZERO,
    BIGINT_ZERO,
    BIGINT_ZERO,
    accountVaultPositionUpdateId,
    transaction
  );
  let newAccountVaultPositionUpdate = vaultPositionUpdateLibrary.createAccountVaultPositionUpdate(
    accountVaultPositionUpdateId,
    newAccountVaultPositionOrder,
    account,
    vault,
    accountVaultPosition.id,
    transaction,
    BIGINT_ZERO, // deposits
    BIGINT_ZERO, // Withdrawals
    BIGINT_ZERO, // sharesMinted
    BIGINT_ZERO, // SharesBurnt
    BIGINT_ZERO, // sharesSent
    BIGINT_ZERO, // sharesReceived
    BIGINT_ZERO, // tokensSent
    BIGINT_ZERO, // tokensReceived
    BIGINT_ZERO,
    BIGINT_ZERO
  );
  accountVaultPosition.save();
  return newAccountVaultPositionUpdate;
}

export function transferForAccount(
  vaultContract: VaultPackage,
  account: Account,
  vault: Vault,
  receivingTransfer: boolean,
  tokenAmount: BigInt,
  shareAmount: BigInt,
  transaction: Transaction
): void {
  let accountVaultPositionId = buildId(account, vault);
  let accountVaultPosition = AccountVaultPosition.load(accountVaultPositionId);
  let balanceShares = vaultContract.balanceOf(Address.fromString(account.id));
  let balancePosition = getBalancePosition(account, vaultContract);
  let latestUpdateId: string;
  let newAccountVaultPositionOrder: BigInt;
  if (accountVaultPosition == null) {
    newAccountVaultPositionOrder = BIGINT_ZERO;
    log.info(
      'GETTING tx {} new order {} for account {} vault position (first latest update)',
      [
        transaction.hash.toHexString(),
        newAccountVaultPositionOrder.toString(),
        account.id,
      ]
    );
  } else {
    log.info(
      'GETTING tx {} new order for account {} vault position id {} (latest update {})',
      [
        transaction.hash.toHexString(),
        account.id,
        accountVaultPosition.id,
        accountVaultPosition.latestUpdate,
      ]
    );
    newAccountVaultPositionOrder = vaultPositionUpdateLibrary.getNewOrder(
      accountVaultPosition.latestUpdate,
      transaction.hash.toHexString()
    );
    log.info(
      'GETTING tx {} new order {} for account {} vault position id {} (latest update {})',
      [
        transaction.hash.toHexString(),
        newAccountVaultPositionOrder.toString(),
        account.id,
        accountVaultPosition.id,
        accountVaultPosition.latestUpdate,
      ]
    );
  }
  latestUpdateId = vaultPositionUpdateLibrary.buildIdFromAccountVaultAndOrder(
    account,
    vault,
    transaction.hash.toHexString(),
    newAccountVaultPositionOrder
  );
  vaultPositionUpdateLibrary.createAccountVaultPositionUpdate(
    latestUpdateId,
    newAccountVaultPositionOrder,
    account,
    vault,
    accountVaultPositionId,
    transaction,
    BIGINT_ZERO,
    BIGINT_ZERO,
    BIGINT_ZERO,
    BIGINT_ZERO,
    receivingTransfer ? BIGINT_ZERO : shareAmount,
    receivingTransfer ? shareAmount : BIGINT_ZERO,
    receivingTransfer ? BIGINT_ZERO : tokenAmount,
    receivingTransfer ? tokenAmount : BIGINT_ZERO,
    balanceShares,
    balancePosition
  );

  if (accountVaultPosition == null) {
    accountVaultPosition = getOrCreate(
      account,
      vault,
      receivingTransfer ? shareAmount : BIGINT_ZERO,
      receivingTransfer ? tokenAmount : BIGINT_ZERO,
      balancePosition,
      BIGINT_ZERO,
      latestUpdateId,
      transaction
    );
  } else {
    accountVaultPosition.balanceTokens = getBalanceTokens(
      accountVaultPosition.balanceTokens,
      tokenAmount
    );
    accountVaultPosition.balanceShares = balanceShares;
    accountVaultPosition.balancePosition = balancePosition;
    accountVaultPosition.balanceProfit = getBalanceProfit(
      accountVaultPosition.balanceShares,
      accountVaultPosition.balanceProfit,
      accountVaultPosition.balanceTokens,
      tokenAmount
    );
    accountVaultPosition.latestUpdate = latestUpdateId;
    accountVaultPosition.save();
  }
}

export function transfer(
  vaultContract: VaultPackage,
  fromAccount: Account,
  toAccount: Account,
  vault: Vault,
  tokenAmount: BigInt,
  shareAmount: BigInt,
  transaction: Transaction
): void {
  log.info('[AccountVaultPosition] Transfer {} from {} to {} ', [
    tokenAmount.toString(),
    fromAccount.id,
    toAccount.id,
  ]);
  let token = Token.load(vault.token) as Token;

  transferForAccount(
    vaultContract,
    fromAccount,
    vault,
    false,
    tokenAmount,
    shareAmount,
    transaction
  );

  transferForAccount(
    vaultContract,
    toAccount,
    vault,
    true,
    tokenAmount,
    shareAmount,
    transaction
  );
}