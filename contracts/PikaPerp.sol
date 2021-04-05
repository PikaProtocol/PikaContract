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

import './IPika.sol';
import './PerpMath.sol';
import './interfaces/IPikaPerp.sol';
import './interfaces/IOracle.sol';

/*
 * @dev A market for inverse perpetual swap and PIKA stablecoin.
    This is partially adapted from Alpha Finance's linear perpetual swap with two key differences:
    1. This market is for inverse perpetual swap.
    (For reference: https://www.bitmex.com/app/inversePerpetualsGuide)
    An inverse perpetual contract is quoted in USD but margined and settled in the base asset(e.g., ETH).
    The benefit is that users can use base asset that they likely already hold for trading, without any stablecoin exposure.
    Traders can now obtain leveraged long or short exposure to ETH while using ETH as collateral and earning returns in ETH.
    Please note that a long position of ETH/USD inverse contract can be viewed as a short position of USD/ETH contract.
    2. PIKA Token is minted when opening a 1x short position and burned when closing the position.
 */
contract PikaPerp is Initializable, ERC1155Upgradeable, ReentrancyGuardUpgradeable, IPikaPerp {
  using PerpMath for uint;
  using PerpMath for int;

  using SafeMathUpgradeable for uint;
  using SafeERC20 for IERC20;
  using SafeCastUpgradeable for uint;
  using SafeCastUpgradeable for int;
  using SignedSafeMathUpgradeable for int;

  modifier onlyGovernor {
    require(
      msg.sender == governor,
      "Only governor can call this function."
    );
    _;
  }

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
    uint fee // The fee collected to the protocol
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

  uint public constant MintLong = 0;
  uint public constant BurnLong = 1;
  uint public constant MintShort = 2;
  uint public constant BurnShort = 3;

  mapping(uint => uint) public supplyOf;
  mapping(uint => uint) public longOffsetOf;
  mapping(uint => uint) public shortOffsetOf;

  address public pika; // The address of PIKA stablecoin.
  IERC20 public token; // The token to settle perpetual contracts.
  IOracle public oracle; // The oracle contract to get the ideal price.
  MarketStatus public status; // The current market status.

  uint public tradingFee; // example: 0.0025e18, 0.25% of notional value.
  uint public fundingAdjustThreshold; // example: 1.025e18, 2.5% threshold.
  uint public safeThreshold; // example: 93% kill factor for liquidation.
  uint public spotMarkThreshold; // example: 1.05e18, 5% consistency requirement.
  uint public decayPerSecond; // example: 0.998e18, 99.8% exponential TWAP decay.
  uint public maxShiftChangePerSecond; // example: uint(0.01e18) / uint(1 days),  1% per day cap.
  uint public maxPokeElapsed; // 1 hour cap.

  uint public reserve0; // The initial virtual reserve for base tokens.
  uint public coeff; // The coefficient factor controlling price slippage.
  uint public reserve; // The current reserve for base tokens.
  uint public liquidationPerSec; // The maximum liquidation amount per second.

  address public governor;
  address public pendingGovernor;
  address public guardian;
  address public pendingGuardian;

  int public shift; // the shift is added to the AMM price as to make up the funding payment.
//  int public override insurance;
  int public insurance;
//  int public override burden;
  int public burden;

  uint public maxSafeLongSlot; // The current highest slot that is safe for long positions.
  uint public minSafeShortSlot; // The current lowest slot that is safe for short positions.

  uint public lastPoke; // Last timestamp when the poke action happened.
  uint public mark; // Mark price, as measured by exponential decay TWAP of spot prices.
//  uint public override mark; // Mark price, as measured by exponential decay TWAP of spot prices.

  /// @dev Initialize a new PikaPerp smart contract instance.
  /// @param uri EIP-1155 token metadata URI path.
  /// @param _token The token to settle perpetual contracts.
  /// @param _oracle The oracle contract to get the ideal price.
  /// @param _coeff The initial coefficient factor for price slippage.
  /// @param _reserve0 The initial virtual reserve for base tokens.
  function initialize(
    string memory uri,
    address _pika,
    IERC20 _token,
    IOracle _oracle,
    uint _tradingFee,
    uint _fundingAdjustThreshold,
    uint _safeThreshold,
    uint _spotMarkThreshold,
    uint _decayPerSecond,
    uint _maxShiftChangePerSecond,
    uint _maxPokeElapsed,
    uint _coeff,
    uint _reserve0,
    uint _liquidationPerSec
  ) public initializer {
    __ERC1155_init(uri);
    pika = _pika;
    token = _token;
    oracle = _oracle;
    // ===== Parameters Start ======
    tradingFee = _tradingFee;
    fundingAdjustThreshold = _fundingAdjustThreshold;
    safeThreshold = _safeThreshold;
    spotMarkThreshold = _spotMarkThreshold;
    decayPerSecond = _decayPerSecond;
    maxShiftChangePerSecond = _maxShiftChangePerSecond;
    maxPokeElapsed = _maxPokeElapsed;
    coeff = _coeff;
    reserve0 = _reserve0;
    reserve = _reserve0;
    liquidationPerSec = _liquidationPerSec;
    // ===== Parameters end ======
    lastPoke = now;
    guardian = msg.sender;
    governor = msg.sender;
    uint spotPx = getSpotPx();
    mark = spotPx;
    uint slot = getSlot(spotPx);
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
      lastPoke = now;
    }
  }

  /// @dev Execute a list of actions atomically.
  /// @param actions The list of encoded actions to execute.
  /// @param maxPay The maximum pay value the caller is willing to commit.
  /// @param minGet The minimum get value the caller is willing to take.
  function execute(
    uint[] memory actions,
    uint maxPay,
    uint minGet
  ) public nonReentrant returns (uint pay, uint get) {
    poke();
    require(status != MarketStatus.NoAction, 'no actions allowed');
    // 1. Aggregate the effects of all the actions with token minting / burning.
    (uint buy, uint sell) = (0, 0);
    for (uint idx = 0; idx < actions.length; idx++) {
      // [ 238-bit size ][ 16-bit slot ][ 2-bit kind ]
      uint kind = actions[idx] & ((1 << 2) - 1);
      uint slot = (actions[idx] >> 2) & ((1 << 16) - 1);
      uint size = actions[idx] >> 18;
      if (kind == MintLong) {
        require(status != MarketStatus.NoMint, 'no minting allowed');
        require(slot <= maxSafeLongSlot, 'strike price is too high');
        buy = buy.add(size);
        get = get.add(_doMint(getLongIdent(slot), size));
      } else if (kind == BurnLong) {
        sell = sell.add(size);
        pay = pay.add(_doBurn(getLongIdent(slot), size));
      } else if (kind == MintShort) {
        require(status != MarketStatus.NoMint, 'no minting allowed');
        require(slot >= minSafeShortSlot, 'strike price is too low');
        sell = sell.add(size);
        pay = pay.add(_doMint(getShortIdent(slot), size));
      } else if (kind == BurnShort) {
        buy = buy.add(size);
        get = get.add(_doBurn(getShortIdent(slot), size));
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
      token.safeTransferFrom(msg.sender, address(this), pay - get);
    } else if (get > pay) {
      token.safeTransfer(msg.sender, get - pay);
    }
    insurance = insurance.add(fee.toInt256());
    emit Execute(msg.sender, actions, pay, get, fee);
    // 4. Check spot price and mark price consistency.
    uint spotPx = getSpotPx();
    require(spotPx.fmul(spotMarkThreshold) > mark, 'slippage is too high');
    require(spotPx.fdiv(spotMarkThreshold) < mark, 'slippage is too high');
  }

  /// @dev Open a long position of the contract, which is equivalent to opening a short position of the inverse pair.
  ///      For example, a long position of TOKEN/USD inverse contract can be viewed as short position of USD/TOKEN contract.
  /// @param size The size of the contract. One contract is close to 1 USD in value.
  /// @param minGet The minimum get value in TOKEN the caller is willing to take.
  function openLong(uint size, uint strike, uint minGet) public returns (uint, uint) {
    // Mint short token of USD/ETH pair
    uint action = MintShort | (getSlot(strike) << 2) | (size << 18);
    uint[] memory actions = new uint[](1);
    actions[0] = action;
    return execute(actions, 0, minGet);
  }

  /// @dev Close a long position of the contract, which is equivalent to closing a short position of the inverse pair.
  /// @param size The size of the contract. One contract is close to 1 USD in value.
  /// @param maxPay The maximum pay value in TOKEN the caller is willing to commit.
  function closeLong(uint size, uint strike, uint maxPay) public returns (uint, uint) {
    // Burn short token of USD/ETH pair
    uint action = BurnShort | (getSlot(strike) << 2) | (size << 18);
    uint[] memory actions = new uint[](1);
    actions[0] = action;
    return execute(actions, maxPay, 0);
  }

  /// @dev Open a SHORT position of the contract, which is equivalent to opening a long position of the inverse pair.
  ///      For example, a short position of TOKEN/USD inverse contract can be viewed as long position of USD/TOKEN contract.
  /// @param size The size of the contract. One contract is close to 1 USD in value.
  /// @param maxPay The maximum pay value in TOKEN the caller is willing to commit.
  function openShort(uint size, uint strike, uint maxPay) public returns (uint, uint) {
    // Mint long token of USD/TOKEN pair
    uint action = MintLong | (getSlot(strike) << 2) | (size << 18);
    uint[] memory actions = new uint[](1);
    actions[0] = action;
    return execute(actions, maxPay, 0);
  }

  /// @dev Close a long position of the contract, which is equivalent to closing a short position of the inverse pair.
  /// @param size The size of the contract. One contract is close to 1 USD in value.
  /// @param minGet The minimum get value in TOKEN the caller is willing to take.
  function closeShort(uint size, uint strike, uint minGet) public returns (uint, uint) {
    // Burn long token of USD/TOKEN pair
    uint action = BurnLong | (getSlot(strike) << 2) | (size << 18);
    uint[] memory actions = new uint[](1);
    actions[0] = action;
    return execute(actions, 0, minGet);
  }

  /// @dev Set the address to become the next governor after accepted.
  /// @param addr The address to become the pending governor.
  function setPendingGovernor(address addr) public {
    require(msg.sender == governor, 'not the governor');
    pendingGovernor = addr;
  }

  /// @dev Accept the governor role. Must be called by the pending governor.
  function acceptGovernor() public {
    require(msg.sender == pendingGovernor, 'not the pending governor');
    governor = msg.sender;
    pendingGovernor = address(0);
  }

  /// @dev Set the address to become the next guardian after accepted.
  /// @param addr The address to become the pending guardian.
  function setPendingGuardian(address addr) public {
    require(msg.sender == governor, 'not the governor');
    pendingGuardian = addr;
  }

  /// @dev Accept the guardian role. Must be called by the pending guardian.
  function acceptGuardian() public {
    require(msg.sender == pendingGuardian, 'not the pending guardian');
    guardian = msg.sender;
    pendingGuardian = address(0);
  }

  /// @dev Deposit more funds to the insurance pool.
  /// @param amount The amount of funds to deposit.
  function deposit(uint amount) public nonReentrant {
    token.safeTransferFrom(msg.sender, address(this), amount);
    insurance = insurance.add(amount.toInt256());
    emit Deposit(msg.sender, amount);
  }

  /// @dev Withdraw some insurance funds. Can only be called by the guardian.
  /// @param amount The amount of funds to withdraw.
  function withdraw(uint amount) public nonReentrant {
    require(msg.sender == guardian, 'not the guardian');
    insurance = insurance.sub(amount.toInt256());
    require(insurance > 0, 'negative insurance after withdrawal');
    token.safeTransfer(msg.sender, amount);
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
    int change;
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
    uint _nextMaxSafeLongSlot = getSlot(mark.fmul(safeThreshold));
    while (_prevMaxSafeLongSlot > _nextMaxSafeLongSlot) {
      uint strike = getStrike(_prevMaxSafeLongSlot);
      uint ident = getLongIdent(_prevMaxSafeLongSlot);
      uint size = supplyOf[ident];
      emit Liquidate(ident, size);
      burden = burden.add(size.toInt256());
      insurance = insurance.sub(strike.fmul(size).toInt256());
      longOffsetOf[_prevMaxSafeLongSlot]++;
      _prevMaxSafeLongSlot--;
    }
    maxSafeLongSlot = _nextMaxSafeLongSlot;
    // Handle short side
    uint _prevMinSafeShortSlot = minSafeShortSlot;
    uint _nextMinSafeShortSlot = getSlot(mark.fdiv(safeThreshold)).add(1);
    while (_prevMinSafeShortSlot < _nextMinSafeShortSlot) {
      uint strike = getStrike(_prevMinSafeShortSlot);
      uint ident = getShortIdent(_prevMinSafeShortSlot);
      uint size = supplyOf[ident];
      emit Liquidate(ident, size);
      burden = burden.sub(size.toInt256());
      insurance = insurance.add(strike.fmul(size).toInt256());
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
      insurance = insurance.add(get.toInt256());
      burden = prevBurden.sub(sell.toInt256());
    } else if (prevBurden < 0) {
      uint limit = liquidationPerSec.mul(timeElapsed);
      uint buy = MathUpgradeable.min(prevBurden.mul(-1).toUint256(), limit);
      uint pay = _doBuy(buy);
      insurance = insurance.sub(pay.toInt256());
      burden = prevBurden.add(buy.toInt256());
    }
  }

  /// @dev Mint position tokens and returns the value of the debt involved. If the strike is 0, mint PIKA stablecoin.
  /// @param ident The identifier of position tokens to mint.
  /// @param size The amount of position tokens to mint.
  function _doMint(uint ident, uint size) internal returns (uint) {
    uint strike = getStrike(ident);
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

  /// @dev Burn position tokens and returns the value of the debt involved.
  /// @param ident The identifier of position tokens to burn.
  /// @param size The amount of position tokens to burn.
  function _doBurn(uint ident, uint size) internal returns (uint) {
    uint strike = getStrike(ident);
    if (strike == 0) {
      IPika(pika).burn(msg.sender, size);
      return 0;
    }
    uint supply = supplyOf[ident];
    uint value = strike.fmul(supply).sub(strike.fmul(supply.sub(size)));
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

  // ============ Getter Functions ============

  /// @dev Return the active ident (slot with offset) for the given long price slot.
  /// @param slot The price slot to query.
  function getLongIdent(uint slot) public view returns (uint) {
    require(slot < (1 << 16), 'bad slot data');
    return (1 << 255) | (longOffsetOf[slot] << 16) | slot;
  }

  /// @dev Return the active ident (slot with offset) for the given short price slot.
  /// @param slot The price slot to query.
  function getShortIdent(uint slot) public view returns (uint) {
    require(slot < (1 << 16), 'bad slot data');
    return (shortOffsetOf[slot] << 16) | slot;
  }

  /// @dev Convert the given strike price to its slot, round down.
  /// @param strike The strike price to convert.
  function getSlot(uint strike) public pure returns (uint) {
    if (strike < 100) return strike + 800;
    uint magnitude = 1;
    while (strike >= 1000) {
      magnitude++;
      strike /= 10;
    }
    return 900 * magnitude + strike - 100;
  }

  /// @dev Convert the given slot identifier to strike price.
  /// @param ident The slot identifier, can be with or without the offset.
  function getStrike(uint ident) public pure returns (uint) {
    uint slot = ident & ((1 << 16) - 1); // only consider the last 16 bits
    uint prefix = slot % 900; // maximum value is 899
    uint magnitude = slot / 900; // maximum value is 72
    if (magnitude == 0) {
      require(prefix >= 800, 'bad prefix');
      return prefix - 800;
    } else {
      return (100 + prefix) * (10**(magnitude - 1)); // never overflow
    }
  }

  /// @dev Return the current approximate spot price of this perp market.
  function getSpotPx() public view returns (uint) {
    uint px = coeff.div(reserve).fdiv(reserve);
    return px.toInt256().add(shift).toUint256();
  }

  /// @dev Get leverage number (multiply 100) for a given strike price
  /// @param strike The price which leverage position will expire(gets liquidated).
  function getLeverageFromStrike(uint256 strike) public view returns(uint) {
    uint latestMark = getLatestMark();
    if (latestMark > strike ) {
      return latestMark.mul(100).div(latestMark - strike);
    }
    return latestMark.mul(100).div(strike - latestMark);
  }

  /// @dev Get strike price from target leverage
  /// @param leverage The leverage(divide by 100) of the position.
  function getStrikeFromLeverage(uint256 leverage, bool isLong) public view returns(uint) {
    uint latestMark = getLatestMark();
    if (isLong) {
      return latestMark.add(latestMark.mul(100).div(leverage));
    }
    return latestMark.sub(latestMark.mul(100).div(leverage));
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

  // ============ Setter Functions ============

  /// @dev Set market status for this perpetual market.
  /// @param _status The new market status.
  function setMarketStatus(MarketStatus _status) public onlyGovernor {
    status = _status;
  }

  /// @dev Update liquidity factors, using insurance fund to maintain invariants.
  /// @param nextCoeff The new coeefficient value.
  /// @param nextReserve0 The new reserve0 value.
  function setLiquidity(uint nextCoeff, uint nextReserve0) public onlyGovernor {
    uint nextReserve = nextReserve0.add(reserve).sub(reserve0);
    int prevVal = coeff.div(reserve).toInt256().sub(coeff.div(reserve0).toInt256());
    int nextVal = nextCoeff.div(nextReserve).toInt256().sub(nextCoeff.div(nextReserve0).toInt256());
    insurance = insurance.add(prevVal).sub(nextVal);
    coeff = nextCoeff;
    reserve0 = nextReserve0;
    reserve = nextReserve;
  }

  /// @dev Update max liquidation per second parameter.
  /// @param nextLiquidationPerSec The new max liquidation parameter.
  function setLiquidationPerSec(uint nextLiquidationPerSec) public onlyGovernor {
    liquidationPerSec = nextLiquidationPerSec;
  }

  function setTradingFee(uint newTradingFee) public onlyGovernor {
    tradingFee = newTradingFee;
  }

  function setFundingAdjustThreshold(uint newFundingAdjustThreshold) public onlyGovernor {
    fundingAdjustThreshold = fundingAdjustThreshold;
  }

  function setSafeThreshold(uint newSafeThreshold) public onlyGovernor {
    safeThreshold = newSafeThreshold;
  }

  function setSpotMarkThreshold(uint newSpotMarkThreshold) public onlyGovernor {
    spotMarkThreshold = newSpotMarkThreshold;
  }

  function setDecayPerSecond(uint newDecayPerSecond) public onlyGovernor {
    decayPerSecond = newDecayPerSecond;
  }

  function setMaxShiftChangePerSecond(uint newMaxShiftChangePerSecond) public onlyGovernor {
    maxShiftChangePerSecond = newMaxShiftChangePerSecond;
  }

  function setMaxPokeElapsed(uint newMaxPokeElapsed) public onlyGovernor {
    maxPokeElapsed = newMaxPokeElapsed;
  }

}
