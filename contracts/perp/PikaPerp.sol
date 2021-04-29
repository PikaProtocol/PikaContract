//SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import '@openzeppelin/contracts-upgradeable/proxy/Initializable.sol';
import '@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol';
import '@openzeppelin/contracts-upgradeable/token/ERC20/SafeERC20Upgradeable.sol';
import '@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol';
import '@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/math/MathUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/utils/SafeCastUpgradeable.sol';

import './IPikaPerp.sol';
import '../token/IPika.sol';
import '../lib/PerpMath.sol';
import '../lib/PerpLib.sol';
import '../lib/UniERC20.sol';
import '../oracle/IOracle.sol';

/*
 * @dev A market for inverse perpetual swap and PIKA stablecoin.
    This is partially adapted from Alpha Finance's linear perpetual swap with many differences. Below are the 3 key differences:
    1. This market is for inverse perpetual swap.
    (For reference: https://www.bitmex.com/app/inversePerpetualsGuide)
    An inverse perpetual contract is quoted in USD but margined and settled in the base token(e.g., ETH).
    The benefit is that users can use base asset that they likely already hold for trading, without any stablecoin exposure.
    Traders can now obtain leveraged long or short exposure to ETH while using ETH as collateral and earning returns in ETH.
    Please note that a long position of TOKEN/USD inverse contract can be viewed as a short position of USD/TOKEN contract.
    All the long and short terms in all the public functions refer to TOKEN/USD pair, while the long and short terms of non-public functions
    refer to USD/TOKEN pair.
    2. PIKA Token is minted when opening a 1x short position and burned when closing the position. Part of trading fee is
    distributed to PIKA holders.
    3. Liquidity is updated dynamically based on open interest change and trading volume change.
 */
contract PikaPerp is Initializable, ERC1155Upgradeable, ReentrancyGuardUpgradeable, IPikaPerp {
  using PerpMath for uint;
  using PerpLib for uint;
  using PerpMath for int;

  using SafeMathUpgradeable for uint;
  using SafeERC20 for IERC20;
  using UniERC20 for IERC20;
  using SafeCastUpgradeable for uint;
  using SafeCastUpgradeable for int;
  using SignedSafeMathUpgradeable for int;

  enum MarketStatus {
    Normal, // Trading operates as normal.
    NoMint, // No minting actions allowed.
    NoAction // No any actions allowed.
  }

  event Execute(
    address indexed sender, // The user who executes the actions.
    uint[] actions, // The list of actions executed.
    uint pay, // The amount of tokens paid by users, including fee.
    uint get, // The amount of tokens paid to users.
    uint fee, // The fee collected to the protocol.
    uint spotPx, // The price of the virtual AMM.
    uint mark, // The mark price.
    uint indexPx, // The oracle price.
    int insurance, // The current insurance amount.
    uint tokenBalance // The current token balance of the protocol.
  );

  event Liquidate(
    uint ident, // The identifier of the bucket that gets liquidated.
    uint size // The total size.
  );

  event Deposit(
    address indexed depositor, // The user who deposits insurance funds.
    uint amount // The amount of funds deposited.
  );

  event Withdraw(
    address indexed guardian, // The guardian who withdraws insurance funds.
    uint amount // The amount of funds withdrawn.
  );

  event Collect(
    address payable indexed referrer, // The user who collects the commission fee.
    uint amount // The amount of tokens collected.
  );

  event RewardDistribute(
    address payable indexed rewardDistributor, // The distributor address to receive the trading fee reward.
    uint amount // The amount of tokens collected.
  );

  event LiquidityChanged(
    uint coeff,  // coefficient factor before the change
    uint reserve0, // initial virtual reserve for base tokens before the change
    uint reserve, // current reserve for base tokens before the change
    uint nextCoeff, // coefficient factor after the change
    uint nextReserve0, // initial virtual reserve for base tokens after the change
    uint nextReserve,  // current reserve for base tokens after the change
    int insuranceChange // the change of the insurance caused by the liquidity update
  );

  uint public constant MintLong = 0;
  uint public constant BurnLong = 1;
  uint public constant MintShort = 2;
  uint public constant BurnShort = 3;

  mapping(uint => uint) public supplyOf;
  mapping(uint => uint) public longOffsetOf;
  mapping(uint => uint) public shortOffsetOf;
  mapping(address => address) public referrerOf;
  mapping(address => uint) public commissionOf;

  address public pika; // The address of PIKA stablecoin.
  IERC20 public token; // The token to settle perpetual contracts.
  IOracle public oracle; // The oracle contract to get the ideal price.
  MarketStatus public status; // The current market status.

  uint public tradingFee;
  uint public referrerCommission;
  uint public pikaRewardRatio; // percent of trading fee to reward pika holders
  uint public fundingAdjustThreshold; // if the difference between mark and index is above this threshold, funding will be adjusted
  uint public safeThreshold; // buffer for liquidation
  uint public spotMarkThreshold;
  uint public decayPerSecond;
  uint public maxShiftChangePerSecond;
  uint public maxPokeElapsed;

  uint public reserve0; // The initial virtual reserve for base tokens.
  uint public coeff; // The coefficient factor controlling price slippage.
  uint public reserve; // The current reserve for base tokens.
  uint public liquidationPerSec; // The maximum liquidation amount per second.
  uint public liquidityChangePerSec; // The maximum liquidity change per second.
  uint public totalOI; // The sum of open long and short positions.
  uint public smallDecayTwapOI; // Total open interest with small exponential TWAP decay. This reflects shorter term twap.
  uint public largeDecayTwapOI; // Total open interest with large exponential TWAP decay. This reflects longer term twap.
  uint public smallOIDecayPerSecond; // example: 0.99999e18, 99.999% exponential TWAP decay.
  uint public largeOIDecayPerSecond; // example: 0.999999e18, 99.9999% exponential TWAP decay.
  uint public OIChangeThreshold; // example: 1.05e18, 105%. If the difference between smallDecayTwapOI and largeDecayTwapOI is larger than threshold, liquidity will be updated.
  uint public dailyVolume; // today's trading volume
  uint public prevDailyVolume; // previous day's trading volume
  uint public volumeChangeThreshold; // example: 1.1e18, 110%. If the difference between dailyVolume and prevDailyVolume is larger than (1 - threshold), liquidity will be updated.
  bool isLiquidityDynamicByOI;
  bool isLiquidityDynamicByVolume;

  address public governor;
  address public pendingGovernor;
  address public guardian;
  address public pendingGuardian;
  address payable public rewardDistributor;

  int public shift; // the shift is added to the AMM price as to make up the funding payment.
  uint public pikaReward; // the trading fee reward for pika holders
  int public override insurance; // the amount of token to back the exchange
//  int public insurance;
  int public override burden;
//  int public burden;

  uint public maxSafeLongSlot; // The current highest slot that is safe for long positions.
  uint public minSafeShortSlot; // The current lowest slot that is safe for short positions.

  uint public lastDailyVolumeUpdateTime; // Last timestamp when the previous daily volume stops accumulating
  uint public lastTwapOIChangeTime; // Last timestamp when the twap open interest updates happened.
  uint public lastLiquidityChangeTime; // Last timestamp when the liquidity changes happened.
  uint public lastPoke; // Last timestamp when the poke action happened.
//  uint public mark; // Mark price, as measured by exponential decay TWAP of spot prices.
  uint public override mark; // Mark price, as measured by exponential decay TWAP of spot prices.

  modifier onlyGovernor {
    require(
      msg.sender == governor,
      "Only governor can call this function."
    );
    _;
  }

  /// @dev Initialize a new PikaPerp smart contract instance.
  /// @param uri EIP-1155 token metadata URI path.
  /// @param _token The token to settle perpetual contracts.
  /// @param _oracle The oracle contract to get the ideal price.
  /// @param _coeff The initial coefficient factor for price slippage.
  /// @param _reserve0 The initial virtual reserve for base tokens.
  /// @param _liquidationPerSec // The maximum liquidation amount per second.
  function initialize(
    string memory uri,
    address _pika,
    IERC20 _token,
    IOracle _oracle,
    uint _coeff,
    uint _reserve0,
    uint _liquidationPerSec
  ) public initializer {
    __ERC1155_init(uri);
    pika = _pika;
    token = _token;
    oracle = _oracle;
    // ===== Parameters Start ======
    tradingFee = 0.0025e18; // 0.25% of notional value
    referrerCommission = 0.10e18; // 10% of trading fee
    pikaRewardRatio = 0.20e18; // 20% of trading fee
    fundingAdjustThreshold = 1.025e18; // 2.5% threshold
    safeThreshold = 0.93e18; // 7% buffer for liquidation
    spotMarkThreshold = 1.05e18; // 5% consistency requirement
    decayPerSecond = 0.998e18; // 99.8% exponential TWAP decay
    maxShiftChangePerSecond = uint(0.01e18) / uint(1 days); // 1% per day cap
    maxPokeElapsed = 1 hours; // 1 hour cap
    coeff = _coeff;
    reserve0 = _reserve0;
    reserve = _reserve0;
    liquidationPerSec = _liquidationPerSec;
    liquidityChangePerSec = uint(0.005e18) / uint(1 days); // 0.5% per day cap for the change triggered by open interest and trading volume respectively, which mean 1% cap in total.
    smallOIDecayPerSecond = 0.99999e18; // 99.999% exponential TWAP decay
    largeOIDecayPerSecond = 0.999999e18; // 99.9999% exponential TWAP decay.
    OIChangeThreshold = 1.05e18; // 110%
    volumeChangeThreshold = 1.2e18; // 120%
    isLiquidityDynamicByOI = false;
    isLiquidityDynamicByVolume = false;
    // ===== Parameters end ======
    lastDailyVolumeUpdateTime = now;
    lastTwapOIChangeTime = now;
    lastLiquidityChangeTime = now;
    lastPoke = now;
    guardian = msg.sender;
    governor = msg.sender;
    uint spotPx = getSpotPx();
    mark = spotPx;
    uint slot = PerpLib.getSlot(spotPx);
    maxSafeLongSlot = slot;
    minSafeShortSlot = slot;
    _moveSlots();
  }

  /// @dev Poke contract state update. Must be called prior to any execution.
  function poke() public {
    uint timeElapsed = now - lastPoke;
    if (timeElapsed > 0) {
      timeElapsed = MathUpgradeable.min(timeElapsed, maxPokeElapsed);
      _updateMark(timeElapsed);
      _updateShift(timeElapsed);
      _moveSlots();
      _liquidate(timeElapsed);
      _updateTwapOI();
      if (isLiquidityDynamicByOI) {
        _updateLiquidityByOI();
      }
      if (isLiquidityDynamicByVolume) {
        _updateLiquidityByVolume();
      }
      _updateVolume();
      lastPoke = now;
    }
  }

  /// @dev Execute a list of actions atomically.
  /// @param actions The list of encoded actions to execute.
  /// @param maxPay The maximum pay value the caller is willing to commit.
  /// @param minGet The minimum get value the caller is willing to take.
  /// @param referrer The address that refers this trader. Only relevant on the first call.
  function execute(
    uint[] memory actions,
    uint maxPay,
    uint minGet,
    address referrer
  ) public payable nonReentrant returns (uint pay, uint get) {
    poke();
    require(status != MarketStatus.NoAction, 'no actions allowed');
    // 1. Aggregate the effects of all the actions with token minting / burning.
    //    Combination of "MintLong and MintShort", "BurnLong and BurnShort" are not allowed.
    (uint buy, uint sell) = (0, 0);
    // use 4 bits to represent boolean of MingLong, BurnLong, MintShort, BurnShort.
    uint kindFlag = 0;
    for (uint idx = 0; idx < actions.length; idx++) {
      // [ 238-bit size ][ 16-bit slot ][ 2-bit kind ]
      uint kind = actions[idx] & ((1 << 2) - 1);
      uint slot = (actions[idx] >> 2) & ((1 << 16) - 1);
      uint size = actions[idx] >> 18;
      if (kind == MintLong) {
        require(status != MarketStatus.NoMint && (kindFlag & (1 << MintShort) == 0), 'no MintLong allowed');
        require(slot <= maxSafeLongSlot, 'strike price is too high');
        buy = buy.add(size);
        get = get.add(_doMint(getLongIdent(slot), size));
        kindFlag = kindFlag | (1 << MintLong);
      } else if (kind == BurnLong) {
        require(kindFlag & (1 << BurnShort) == 0, 'no BurnLong allowed');
        sell = sell.add(size);
        pay = pay.add(_doBurn(getLongIdent(slot), size));
        kindFlag = kindFlag | (1 << BurnLong);
      } else if (kind == MintShort) {
        require(status != MarketStatus.NoMint && (kindFlag & (1 << MintLong) == 0), 'no MintShort allowed');
        require(slot >= minSafeShortSlot, 'strike price is too low');
        sell = sell.add(size);
        pay = pay.add(_doMint(getShortIdent(slot), size));
        kindFlag = kindFlag | (1 << MintShort);
      } else if (kind == BurnShort) {
        require(kindFlag & (1 << BurnLong) == 0, 'no BurnShort allowed');
        buy = buy.add(size);
        get = get.add(_doBurn(getShortIdent(slot), size));
        kindFlag = kindFlag | (1 << BurnShort);
      } else {
        assert(false); // not reachable
      }
    }
    // 2. Perform one buy or one sell based on the aggregated actions.
    uint fee = 0;
    if (buy > sell) {
      uint value = _doBuy(buy - sell);
      fee = tradingFee.fmul(value);
      pay = pay.add(value).add(fee);
    } else if (sell > buy) {
      uint value = _doSell(sell - buy);
      fee = tradingFee.fmul(value);
      get = get.add(value).sub(fee);
    }
    require(pay <= maxPay, 'max pay constraint violation');
    require(get >= minGet, 'min get constraint violation');
    // 3. Settle tokens with the executor and collect the trading fee.
    if (pay > get) {
      token.uniTransferFromSenderToThis(pay - get);
    } else if (get > pay) {
      token.uniTransfer(msg.sender, get - pay);
    }
    uint reward = pikaRewardRatio.fmul(fee);
    pikaReward = pikaReward.add(reward);
    address beneficiary = referrerOf[msg.sender];
    if (beneficiary == address(0)) {
      require(referrer != msg.sender, 'bad referrer');
      beneficiary = referrer;
      referrerOf[msg.sender] = referrer;
    }
    if (beneficiary != address(0)) {
      uint commission = referrerCommission.fmul(fee);
      commissionOf[beneficiary] = commissionOf[beneficiary].add(commission);
      insurance = insurance.add(fee.sub(commission).sub(reward).toInt256());
    } else {
      insurance = insurance.add(fee.sub(reward).toInt256());
    }
    // 4. Check spot price and mark price consistency.
    uint spotPx = getSpotPx();
    emit Execute(msg.sender, actions, pay, get, fee, spotPx, mark, oracle.getPrice(), insurance, token.uniBalanceOf(address(this)));
    require(spotPx.fmul(spotMarkThreshold) > mark, 'slippage is too high');
    require(spotPx.fdiv(spotMarkThreshold) < mark, 'slippage is too high');
  }

  /// @dev Open a long position of the contract, which is equivalent to opening a short position of the inverse pair.
  ///      For example, a long position of TOKEN/USD inverse contract can be viewed as short position of USD/TOKEN contract.
  /// @param size The size of the contract. One contract is close to 1 USD in value.
  /// @param strike The price which the leverage token is worth 0.
  /// @param minGet The minimum get value in TOKEN the caller is willing to take.
  /// @param referrer The address that refers this trader. Only relevant on the first call.
  function openLong(uint size, uint strike, uint minGet, address referrer) external payable returns (uint, uint) {
    // Mint short token of USD/TOKEN pair
    return execute(getTradeAction(MintShort, size, strike), uint256(-1), minGet, referrer);
  }

  /// @dev Close a long position of the contract, which is equivalent to closing a short position of the inverse pair.
  /// @param size The size of the contract. One contract is close to 1 USD in value.
  /// @param strike The price which the leverage token is worth 0.
  /// @param maxPay The maximum pay size in leveraged token the caller is willing to commit.
  /// @param referrer The address that refers this trader. Only relevant on the first call.
  function closeLong(uint size, uint strike, uint maxPay, address referrer) external returns (uint, uint) {
    // Burn short token of USD/TOKEN pair
    return execute(getTradeAction(BurnShort, size, strike), maxPay, 0, referrer);
  }

  /// @dev Open a SHORT position of the contract, which is equivalent to opening a long position of the inverse pair.
  ///      For example, a short position of TOKEN/USD inverse contract can be viewed as long position of USD/ETH contract.
  /// @param size The size of the contract. One contract is close to 1 USD in value.
  /// @param strike The price which the leverage token is worth 0.
  /// @param maxPay The maximum pay value in ETH the caller is willing to commit.
  /// @param referrer The address that refers this trader. Only relevant on the first call.
  function openShort(uint size, uint strike, uint maxPay, address referrer) external payable returns (uint, uint) {
    // Mint long token of USD/TOKEN pair
    return execute(getTradeAction(MintLong, size, strike), maxPay, 0, referrer);
  }

  /// @dev Close a long position of the contract, which is equivalent to closing a short position of the inverse pair.
  /// @param size The size of the contract. One contract is close to 1 USD in value.
  /// @param strike The price which the leverage token is worth 0.
  /// @param minGet The minimum get value in TOKEN the caller is willing to take.
  /// @param referrer The address that refers this trader. Only relevant on the first call.
  function closeShort(uint size, uint strike, uint minGet, address referrer) external returns (uint, uint) {
    // Burn long token of USD/TOKEN pair
    return execute(getTradeAction(BurnLong, size, strike), uint256(-1), minGet, referrer);
  }

  /// @dev Collect trading commission for the caller.
  /// @param amount The amount of commission to collect.
  function collect(uint amount) external nonReentrant {
    commissionOf[msg.sender] = commissionOf[msg.sender].sub(amount);
    token.uniTransfer(msg.sender, amount);
    emit Collect(msg.sender, amount);
  }

  /// @dev Deposit more funds to the insurance pool.
  /// @param amount The amount of funds to deposit.
  function deposit(uint amount) external nonReentrant {
    token.uniTransferFromSenderToThis(amount);
    insurance = insurance.add(amount.toInt256());
    emit Deposit(msg.sender, amount);
  }

  /// @dev Withdraw some insurance funds. Can only be called by the guardian.
  /// @param amount The amount of funds to withdraw.
  function withdraw(uint amount) external nonReentrant {
    require(msg.sender == guardian, 'not the guardian');
    insurance = insurance.sub(amount.toInt256());
    require(insurance > 0, 'negative insurance after withdrawal');
    token.uniTransfer(msg.sender, amount);
    emit Withdraw(msg.sender, amount);
  }

  /// @dev Update the mark price, computed as average spot prices with decay.
  /// @param timeElapsed The number of seconds since last mark price update.
  function _updateMark(uint timeElapsed) internal {
    mark = getMark(timeElapsed);
  }

  /// @dev Update the shift price shift factor.
  /// @param timeElapsed The number of seconds since last shift update.
  function _updateShift(uint timeElapsed) internal {
    uint target = oracle.getPrice();
    int change = 0;
    if (mark.fdiv(fundingAdjustThreshold) > target) {
      change = mark.mul(timeElapsed).toInt256().mul(-1).fmul(maxShiftChangePerSecond);
    } else if (mark.fmul(fundingAdjustThreshold) < target) {
      change = mark.mul(timeElapsed).toInt256().fmul(maxShiftChangePerSecond);
    } else {
      return; // nothing to do here
    }
    int prevShift = shift;
    int nextShift = prevShift.add(change);
    int prevExtra = prevShift.fmul(reserve).sub(prevShift.fmul(reserve0));
    int nextExtra = nextShift.fmul(reserve).sub(nextShift.fmul(reserve0));
    insurance = insurance.add(nextExtra.sub(prevExtra));
    shift = nextShift;
  }

  /// @dev Update the slot boundary variable and perform kill on bad slots.
  function _moveSlots() internal {
    // Handle long side
    uint _prevMaxSafeLongSlot = maxSafeLongSlot;
    uint _nextMaxSafeLongSlot = PerpLib.getSlot(mark.fmul(safeThreshold));
    while (_prevMaxSafeLongSlot > _nextMaxSafeLongSlot) {
      uint strike = PerpLib.getStrike(_prevMaxSafeLongSlot);
      uint ident = getLongIdent(_prevMaxSafeLongSlot);
      uint size = supplyOf[ident];
      emit Liquidate(ident, size);
      burden = burden.add(size.toInt256());
      insurance = insurance.sub(size.fmul(strike).toInt256());
      longOffsetOf[_prevMaxSafeLongSlot]++;
      _prevMaxSafeLongSlot--;
    }
    maxSafeLongSlot = _nextMaxSafeLongSlot;
    // Handle short side
    uint _prevMinSafeShortSlot = minSafeShortSlot;
    uint _nextMinSafeShortSlot = PerpLib.getSlot(mark.fdiv(safeThreshold)).add(1);
    while (_prevMinSafeShortSlot < _nextMinSafeShortSlot) {
      uint strike = PerpLib.getStrike(_prevMinSafeShortSlot);
      uint ident = getShortIdent(_prevMinSafeShortSlot);
      uint size = supplyOf[ident];
      emit Liquidate(ident, size);
      burden = burden.sub(size.toInt256());
      insurance = insurance.add(size.fmul(strike).toInt256());
      shortOffsetOf[_prevMinSafeShortSlot]++;
      _prevMinSafeShortSlot++;
    }
    minSafeShortSlot = _nextMinSafeShortSlot;
  }

  /// @dev Use insurance fund to the burden up to the limit to bring burden to zero.
  function _liquidate(uint timeElapsed) internal {
    int prevBurden = burden;
    if (prevBurden > 0) {
      uint limit = liquidationPerSec.mul(timeElapsed);
      uint sell = MathUpgradeable.min(prevBurden.toUint256(), limit);
      uint get = _doSell(sell);
      totalOI = totalOI.sub(sell); // reduce open interest
      dailyVolume = dailyVolume.add(sell);
      insurance = insurance.add(get.toInt256());
      burden = prevBurden.sub(sell.toInt256());
    } else if (prevBurden < 0) {
      uint limit = liquidationPerSec.mul(timeElapsed);
      uint buy = MathUpgradeable.min(prevBurden.mul(-1).toUint256(), limit);
      uint pay = _doBuy(buy);
      totalOI = totalOI.add(buy);  // reduce open interest
      dailyVolume = dailyVolume.add(buy);
      insurance = insurance.sub(pay.toInt256());
      burden = prevBurden.add(buy.toInt256());
    }
  }

  /// @dev Mint position tokens and returns the value of the debt involved. If the strike is 0, mint PIKA stablecoin.
  /// @param ident The identifier of position tokens to mint.
  /// @param size The amount of position tokens to mint.
  function _doMint(uint ident, uint size) internal returns (uint) {
    totalOI = totalOI.add(size);
    dailyVolume = dailyVolume.add(size);
    uint strike = PerpLib.getStrike(ident);
    if (strike == 0) {
      IPika(pika).mint(msg.sender, size);
      return 0;
    }
    uint supply = supplyOf[ident];
    uint value = strike.fmul(supply.add(size)).sub(strike.fmul(supply));
    supplyOf[ident] = supply.add(size);
    _mint(msg.sender, ident, size, '');
    return value;
  }

  /// @dev Burn position tokens and returns the value of the debt involved. If the strike is 0, burn PIKA stablecoin.
  /// @param ident The identifier of position tokens to burn.
  /// @param size The amount of position tokens to burn.
  function _doBurn(uint ident, uint size) internal returns (uint) {
    totalOI = totalOI.sub(size);
    dailyVolume = dailyVolume.add(size);
    uint strike = PerpLib.getStrike(ident);
    if (strike == 0) {
      IPika(pika).burn(msg.sender, size);
      return 0;
    }
    uint supply = supplyOf[ident];
    uint value = strike.fmul(supply.add(size)).sub(strike.fmul(supply));
    supplyOf[ident] = supply.sub(size);
    _burn(msg.sender, ident, size);
    return value;
  }

  /// @dev Buy virtual tokens and return the amount of quote tokens required.
  /// @param size The amount of tokens to buy.
  function _doBuy(uint size) internal returns (uint) {
    uint nextReserve = reserve.sub(size);
    uint base = coeff.div(nextReserve).sub(coeff.div(reserve));
    int premium = shift.fmul(reserve).sub(shift.fmul(nextReserve));
    reserve = nextReserve;
    return base.toInt256().add(premium).toUint256();
  }

  /// @dev Sell virtual tokens and return the amount of quote tokens received.
  /// @param size The amount of tokens to sell.
  function _doSell(uint size) internal returns (uint) {
    uint nextReserve = reserve.add(size);
    uint base = coeff.div(reserve).sub(coeff.div(nextReserve));
    int premium = shift.fmul(nextReserve).sub(shift.fmul(reserve));
    reserve = nextReserve;
    return base.toInt256().add(premium).toUint256();
  }

  /// @dev Update trading volume for previous day every 24 hours.
  function _updateVolume() internal {
    if (now - lastDailyVolumeUpdateTime > 24 hours) {
      prevDailyVolume = dailyVolume;
      dailyVolume = 0;
      lastDailyVolumeUpdateTime = now;
    }
  }

  /// @dev Update exponential twap open interest for small and large period of interval.
  function _updateTwapOI() internal {
    uint timeElapsed = now - lastTwapOIChangeTime;
    smallDecayTwapOI = smallDecayTwapOI == 0 ? totalOI : PerpLib.getTwapOI(timeElapsed, smallDecayTwapOI, smallOIDecayPerSecond, totalOI);
    largeDecayTwapOI = largeDecayTwapOI == 0 ? totalOI: PerpLib.getTwapOI(timeElapsed, largeDecayTwapOI, largeOIDecayPerSecond, totalOI);
    lastTwapOIChangeTime = now;
  }

  /// @dev Update liquidity dynamically based on open interest change.
  function _updateLiquidityByOI() internal {
    if (smallDecayTwapOI == 0 || smallDecayTwapOI == 0) {
      return;
    }
    uint timeElapsed = now - lastLiquidityChangeTime;
    uint change = coeff.mul(timeElapsed).fmul(liquidityChangePerSec);
    if (smallDecayTwapOI.fdiv(largeDecayTwapOI) > OIChangeThreshold) {
    // Since recent OI increased, increase liquidity.
      uint nextCoeff = coeff.add(change);
      uint nextReserve = (nextCoeff.fdiv(getSpotPx())).sqrt();
      uint nextReserve0 = nextReserve.add(reserve0).sub(reserve);
      _setLiquidity(nextCoeff, nextReserve0);
    } else if (largeDecayTwapOI.fdiv(smallDecayTwapOI) > OIChangeThreshold) {
      // Since recent OI decreased, decrease liquidity.
      uint nextCoeff = coeff.sub(change);
      uint nextReserve = (nextCoeff.fdiv(getSpotPx())).sqrt();
      uint nextReserve0 = nextReserve.add(reserve0).sub(reserve);
      _setLiquidity(nextCoeff, nextReserve0);
    }
    lastLiquidityChangeTime = now;
  }

  /// @dev Update liquidity dynamically based on 24 hour trading volume change.
  function _updateLiquidityByVolume() internal {
    if (now - lastDailyVolumeUpdateTime < 24 hours || prevDailyVolume == 0 || dailyVolume == 0) {
      return;
    }
    uint change = coeff.mul(now - lastDailyVolumeUpdateTime).fmul(liquidityChangePerSec);
    if (dailyVolume.fdiv(prevDailyVolume) > volumeChangeThreshold) {
      uint nextCoeff = coeff.add(change);
      uint nextReserve = (nextCoeff.fdiv(getSpotPx())).sqrt();
      uint nextReserve0 = nextReserve.add(reserve0).sub(reserve);
      _setLiquidity(nextCoeff, nextReserve0);
    } else if (prevDailyVolume.fdiv(dailyVolume) > volumeChangeThreshold) {
      uint nextCoeff = coeff.sub(change);
      uint nextReserve = (nextCoeff.fdiv(getSpotPx())).sqrt();
      uint nextReserve0 = nextReserve.add(reserve0).sub(reserve);
      _setLiquidity(nextCoeff, nextReserve0);
    }
  }

  /// @dev Update liquidity factors, using insurance fund to maintain invariants.
  /// @param nextCoeff The new coeefficient value.
  /// @param nextReserve0 The new reserve0 value.
  function _setLiquidity(uint nextCoeff, uint nextReserve0) internal {
    uint nextReserve = nextReserve0.add(reserve).sub(reserve0);
    int prevVal = coeff.div(reserve).toInt256().sub(coeff.div(reserve0).toInt256());
    int nextVal = nextCoeff.div(nextReserve).toInt256().sub(nextCoeff.div(nextReserve0).toInt256());
    insurance = insurance.add(prevVal).sub(nextVal);
    coeff = nextCoeff;
    reserve0 = nextReserve0;
    reserve = nextReserve;
    emit LiquidityChanged(coeff, reserve0, reserve, nextCoeff, nextReserve0, nextReserve, prevVal.sub(nextVal));
  }

  function distributeReward() external override returns (uint256) {
    if (pikaReward > 0) {
      token.uniTransfer(rewardDistributor, pikaReward);
      emit RewardDistribute(rewardDistributor, pikaReward);
      uint distributedReward = pikaReward;
      pikaReward = 0;
      return distributedReward;
    }
    return 0;
  }

  // ============ Getter Functions ============

  function getTradeAction(uint kind, uint size, uint strike) public pure returns (uint[] memory){
    uint action = kind | (PerpLib.getSlot(strike) << 2) | (size << 18);
    uint[] memory actions = new uint[](1);
    actions[0] = action;
    return actions;
  }

  /// @dev Return the active ident (slot with offset) for the given long price slot. The long refers to USD/TOKEN pair.
  /// @param slot The price slot to query.
  function getLongIdent(uint slot) public view returns (uint) {
    require(slot < (1 << 16), 'bad slot');
    return (1 << 255) | (longOffsetOf[slot] << 16) | slot;
  }

  /// @dev Return the active ident (slot with offset) for the given short price slot. The short refers to USD/TOKEN pair.
  /// @param slot The price slot to query.
  function getShortIdent(uint slot) public view returns (uint) {
    require(slot < (1 << 16), 'bad slot');
    return (shortOffsetOf[slot] << 16) | slot;
  }

  /// @dev Return the current user position of leveraged token for a strike.
  /// @param account Address of a user.
  /// @param strike The price which the leverage token is worth 0.
  /// @param isLong Whether is long or short in terms of TOKEN/USD pair.
  function getPosition(address account, uint strike, bool isLong) public view returns (uint) {
      uint slot = PerpLib.getSlot(strike);
      uint ident = isLong ? getShortIdent(slot) : getLongIdent(slot);
      return balanceOf(account, ident);
  }

  /// @dev Return the current approximate spot price of this perp market.
  function getSpotPx() public view returns (uint) {
    uint px = coeff.div(reserve).fdiv(reserve);
    return px.toInt256().add(shift).toUint256();
  }

  /// @dev Get strike price from target leverage
  /// @param leverage The leverage of the position.
  /// @param isLong Whether is long or short in terms of TOKEN/USD pair.
  function getStrikeFromLeverage(uint256 leverage, bool isLong) public view returns(uint) {
    uint latestMark = getLatestMark();
    if (isLong) {
      return latestMark.add(latestMark.fdiv(leverage));
    }
    return latestMark.sub(latestMark.fdiv(leverage));
  }

  /// @dev Get the mark price, computed as average spot prices with decay.
  /// @param timeElapsed The number of seconds since last mark price update.
  function getMark(uint timeElapsed) public view returns (uint) {
    uint total = 1e18;
    uint each = decayPerSecond;
    while (timeElapsed > 0) {
      if (timeElapsed & 1 != 0) {
        total = total.fmul(each);
      }
      each = each.fmul(each);
      timeElapsed = timeElapsed >> 1;
    }
    uint prev = total.fmul(mark);
    uint next = uint(1e18).sub(total).fmul(getSpotPx());
    return prev.add(next);
  }

  /// @dev Get the latest mark price, computed as average spot prices with decay.
  function getLatestMark() public view returns (uint) {
    uint timeElapsed = now - lastPoke;
    if (timeElapsed > 0) {
      return getMark(timeElapsed);
    }
    return mark;
  }

  /// @dev Get the reward that has not been distributed.
  function getPendingReward() external override view returns (uint256) {
    return pikaReward;
  }


// ============ Setter Functions ============

  /// @dev Set the address to become the next guardian.
  /// @param addr The address to become the guardian.
  function setGuardian(address addr) external onlyGovernor {
    guardian = addr;
  }

  /// @dev Set the address to become the next governor.
  /// @param addr The address to become the governor.
  function setGovernor(address addr) external onlyGovernor {
    governor = addr;
  }

  /// @dev Set the distributor address to receive the trading fee reward.
  function setRewardDistributor(address payable newRewardDistributor) external onlyGovernor {
    rewardDistributor = newRewardDistributor;
  }

  function setLiquidity(uint nextCoeff, uint nextReserve0) external onlyGovernor {
    _setLiquidity(nextCoeff, nextReserve0);
  }

  /// @dev Set market status for this perpetual market.
  /// @param _status The new market status.
  function setMarketStatus(MarketStatus _status) external onlyGovernor {
    status = _status;
  }


  // @dev setters for per second parameters. Combine the setters to one function to reduce contract size.
  function setParametersPerSec(uint nextLiquidationPerSec, uint newDecayPerSecond, uint newMaxShiftChangePerSecond) external onlyGovernor {
    liquidationPerSec = nextLiquidationPerSec;
    decayPerSecond = newDecayPerSecond;
    maxShiftChangePerSecond = newMaxShiftChangePerSecond;
  }

  // @dev setters for thresholds parameters. Combine the setters to one function to reduce contract size.
  function setThresholds(uint newFundingAdjustThreshold, uint newSafeThreshold, uint newSpotMarkThreshold, uint newOIChangeThreshold, uint newVolumeChangeThreshold) external onlyGovernor {
    fundingAdjustThreshold = newFundingAdjustThreshold;
    safeThreshold = newSafeThreshold;
    spotMarkThreshold = newSpotMarkThreshold;
    OIChangeThreshold = newOIChangeThreshold;
    volumeChangeThreshold = newVolumeChangeThreshold;
  }

  function setTradingFee(uint newTradingFee) external onlyGovernor {
    tradingFee = newTradingFee;
  }

  function setReferrerCommission(uint newReferrerCommission) external onlyGovernor {
    referrerCommission = newReferrerCommission;
  }

  function setPikaRewardRatio(uint newPikaRewardRatio) external onlyGovernor {
    pikaRewardRatio = newPikaRewardRatio;
  }

  function setMaxPokeElapsed(uint newMaxPokeElapsed) external onlyGovernor {
    maxPokeElapsed = newMaxPokeElapsed;
  }

  function setDynamicLiquidity(bool isDynamicByOI, bool isDynamicByVolume) external onlyGovernor {
    isLiquidityDynamicByOI = isDynamicByOI;
    isLiquidityDynamicByVolume = isDynamicByVolume;
  }
}

