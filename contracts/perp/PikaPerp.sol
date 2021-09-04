//SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/math/MathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/SafeCastUpgradeable.sol";
import "hardhat/console.sol";

import "./IPikaPerp.sol";
import "../token/IPika.sol";
import "../lib/PerpMath.sol";
import "../lib/PerpLib.sol";
import "../lib/UniERC20.sol";
import "../oracle/IOracle.sol";

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
contract PikaPerp is
    Initializable,
    ERC1155Upgradeable,
    ReentrancyGuardUpgradeable,
    IPikaPerp
{
    using PerpMath for uint256;
    using PerpLib for uint256;
    using PerpMath for int256;

    using SafeMathUpgradeable for uint256;
    using SafeERC20 for IERC20;
    using UniERC20 for IERC20;
    using SafeCastUpgradeable for uint256;
    using SafeCastUpgradeable for int256;
    using SignedSafeMathUpgradeable for int256;

    enum MarketStatus {
        Normal, // Trading operates as normal.
        NoMint, // No minting actions allowed.
        NoAction // No any actions allowed.
    }

    event Execute(
        address indexed sender, // The user who executes the actions.
        uint256[] actions, // The list of actions executed.
        uint256 pay, // The amount of tokens paid by users, including fee.
        uint256 get, // The amount of tokens paid to users.
        uint256 fee, // The fee collected to the protocol.
        uint256 spotPx, // The price of the virtual AMM.
        uint256 mark, // The mark price.
        uint256 indexPx, // The oracle price.
        int256 shift, //  The amount added to the AMM price as to make up the funding payment.
        int256 insurance, // The current insurance amount.
        uint256 commission, // The commission of this trade.
        uint256 reward, // The reward for Pika holders.
        uint256 timestamp // Current timestamp.
    );

    event Liquidate(
        uint256 ident, // The identifier of the bucket that gets liquidated.
        uint256 size // The total size.
    );

    event Deposit(
        address indexed depositor, // The user who deposits insurance funds.
        uint256 amount // The amount of funds deposited.
    );

    event Withdraw(
        address indexed guardian, // The guardian who withdraws insurance funds.
        uint256 amount // The amount of funds withdrawn.
    );

    event Collect(
        address payable indexed referrer, // The user who collects the commission fee.
        uint256 amount // The amount of tokens collected.
    );

    event RewardDistribute(
        address payable indexed rewardDistributor, // The distributor address to receive the trading fee reward.
        uint256 amount // The amount of tokens collected.
    );

    event LiquidityChanged(
        uint256 coeff, // coefficient factor before the change
        uint256 reserve0, // initial virtual reserve for base tokens before the change
        uint256 reserve, // current reserve for base tokens before the change
        uint256 nextCoeff, // coefficient factor after the change
        uint256 nextReserve0, // initial virtual reserve for base tokens after the change
        uint256 nextReserve, // current reserve for base tokens after the change
        int256 insuranceChange // the change of the insurance caused by the liquidity update
    );

    uint256 public constant MintLong = 0;
    uint256 public constant BurnLong = 1;
    uint256 public constant MintShort = 2;
    uint256 public constant BurnShort = 3;

    mapping(uint256 => uint256) public supplyOf;
    mapping(uint256 => uint256) public longOffsetOf;
    mapping(uint256 => uint256) public shortOffsetOf;
    mapping(address => address) public referrerOf;
    mapping(address => uint256) public commissionOf;

    address public pika; // The address of PIKA stablecoin.
    IERC20 public token; // The token to settle perpetual contracts.
    IOracle public oracle; // The oracle contract to get the ideal price.
    MarketStatus public status; // The current market status.

    uint256 public tradingFee;
    uint256 public referrerCommission;
    uint256 public pikaRewardRatio; // percent of trading fee to reward pika holders
    uint256 public fundingAdjustThreshold; // if the difference between mark and index is above this threshold, funding will be adjusted
    uint256 public safeThreshold; // buffer for liquidation
    uint256 public spotMarkThreshold;
    uint256 public decayPerSecond;
    uint256 public maxPokeElapsed;

    uint256 public reserve0; // The initial virtual reserve for base tokens.
    uint256 public coeff; // The coefficient factor controlling price slippage.
    uint256 public reserve; // The current reserve for base tokens.
    uint256 public liquidationPerSec; // The maximum liquidation amount per second.
    uint256 public liquidityChangePerSec; // The maximum liquidity change per second.
    uint256 public totalOI; // The sum of open long and short positions.
    uint256 public smallDecayTwapOI; // Total open interest with small exponential TWAP decay. This reflects shorter term twap.
    uint256 public largeDecayTwapOI; // Total open interest with large exponential TWAP decay. This reflects longer term twap.
    uint256 public smallOIDecayPerSecond; // example: 0.99999e18, 99.999% exponential TWAP decay.
    uint256 public largeOIDecayPerSecond; // example: 0.999999e18, 99.9999% exponential TWAP decay.
    uint256 public OIChangeThreshold; // example: 1.05e18, 105%. If the difference between smallDecayTwapOI and largeDecayTwapOI is larger than threshold, liquidity will be updated.
    uint256 public dailyVolume; // today's trading volume
    uint256 public prevDailyVolume; // previous day's trading volume
    uint256 public volumeChangeThreshold; // example: 1.2e18, 120%. If the difference between dailyVolume and prevDailyVolume is larger than threshold), liquidity will be updated.
    bool public isLiquidityDynamicByOI;
    bool public isLiquidityDynamicByVolume;

    address public governor;
    address public guardian;
    address payable public rewardDistributor;

    int256 public shift; // the shift is added to the AMM price as to make up the funding payment.
    uint256 public pikaReward; // the trading fee reward for pika holders.
    int256 public override insurance; // the amount of token to back the exchange.
    int256 public override burden;

    uint256 public maxSafeLongSlot; // The current highest slot that is safe for long positions.
    uint256 public minSafeShortSlot; // The current lowest slot that is safe for short positions.

    uint256 public lastDailyVolumeUpdateTime; // Last timestamp when the previous daily volume stops accumulating
    uint256 public lastTwapOIChangeTime; // Last timestamp when the twap open interest updates happened.
    uint256 public lastLiquidityChangeTime; // Last timestamp when the liquidity changes happened.
    uint256 public lastPoke; // Last timestamp when the poke action happened.
    uint256 public override mark; // Mark price, as measured by exponential decay TWAP of spot prices.

    modifier onlyGovernor() {
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
        uint256 _coeff,
        uint256 _reserve0,
        uint256 _reserve,
        uint256 _liquidationPerSec
    ) public initializer {
        require(_pika != address(0), "_pika is a zero address");
        require(address(_oracle) != address(0), "_oracle is a zero address");
        __ERC1155_init(uri);
        pika = _pika;
        token = _token;
        oracle = _oracle;
        // ===== Parameters Start ======
        tradingFee = 0.001e18; // 0.25% of notional value
        referrerCommission = 0.10e18; // 10% of trading fee
        pikaRewardRatio = 0.20e18; // 20% of trading fee
        fundingAdjustThreshold = 0.005e18; // 0.5% threshold
        safeThreshold = 0.93e18; // 7% buffer for liquidation
        spotMarkThreshold = 1.05e18; // 5% consistency requirement
        decayPerSecond = 0.998e18; // 99.8% exponential TWAP decay
        maxPokeElapsed = 1 hours; // 1 hour cap
        coeff = _coeff;
        reserve0 = _reserve0;
        reserve = _reserve;
        liquidationPerSec = _liquidationPerSec;
        liquidityChangePerSec = uint256(0.002e18) / uint256(1 days); // 0.2% per day cap for the change triggered by open interest and trading volume respectively, which mean 1% cap in total.
        smallOIDecayPerSecond = 0.99999e18; // 99.999% exponential TWAP decay
        largeOIDecayPerSecond = 0.999999e18; // 99.9999% exponential TWAP decay.
        OIChangeThreshold = 1.05e18; // 105%
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
        uint256 spotPx = getSpotPx();
        mark = spotPx;
        uint256 slot = PerpLib.getSlot(spotPx);
        maxSafeLongSlot = slot;
        minSafeShortSlot = slot;
        shift = -12128111902382;
        _moveSlots();
    }

    /// @dev Poke contract state update. Must be called prior to any execution.
    function poke() public {
        uint256 timeElapsed = now - lastPoke;
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
        uint256[] memory actions,
        uint256 maxPay,
        uint256 minGet,
        address referrer
    ) public payable nonReentrant returns (uint256 pay, uint256 get) {
        poke();
        require(status != MarketStatus.NoAction, "no actions allowed");
        // 1. Aggregate the effects of all the actions with token minting / burning.
        //    Combination of "MintLong and MintShort", "BurnLong and BurnShort" are not allowed.
        (uint256 buy, uint256 sell) = (0, 0);
        // use 4 bits to represent boolean of MingLong, BurnLong, MintShort, BurnShort.
        uint256 kindFlag = 0;
        for (uint256 idx = 0; idx < actions.length; idx++) {
            // [ 238-bit size ][ 16-bit slot ][ 2-bit kind ]
            uint256 kind = actions[idx] & ((1 << 2) - 1);
            uint256 slot = (actions[idx] >> 2) & ((1 << 16) - 1);
            uint256 size = actions[idx] >> 18;
            if (kind == MintLong) {
                require(
                    status != MarketStatus.NoMint &&
                        (kindFlag & (1 << MintShort) == 0),
                    "no MintLong allowed"
                );
                require(slot <= maxSafeLongSlot, "strike price is too high");
                buy = buy.add(size);
                get = get.add(_doMint(getLongIdent(slot), size));
                kindFlag = kindFlag | (1 << MintLong);
            } else if (kind == BurnLong) {
                require(
                    kindFlag & (1 << BurnShort) == 0,
                    "no BurnLong allowed"
                );
                sell = sell.add(size);
                pay = pay.add(_doBurn(getLongIdent(slot), size));
                kindFlag = kindFlag | (1 << BurnLong);
            } else if (kind == MintShort) {
                require(
                    status != MarketStatus.NoMint &&
                        (kindFlag & (1 << MintLong) == 0),
                    "no MintShort allowed"
                );
                require(slot >= minSafeShortSlot, "strike price is too low");
                sell = sell.add(size);
                pay = pay.add(_doMint(getShortIdent(slot), size));
                kindFlag = kindFlag | (1 << MintShort);
            } else if (kind == BurnShort) {
                require(
                    kindFlag & (1 << BurnLong) == 0,
                    "no BurnShort allowed"
                );
                buy = buy.add(size);
                get = get.add(_doBurn(getShortIdent(slot), size));
                kindFlag = kindFlag | (1 << BurnShort);
            } else {
                assert(false); // not reachable
            }
        }
        // 2. Perform one buy or one sell based on the aggregated actions.
        uint256 fee = 0;
        if (buy > sell) {
            uint256 value = _doBuy(buy - sell);
            fee = tradingFee.fmul(value);
            pay = pay.add(value).add(fee);
        } else if (sell > buy) {
            uint256 value = _doSell(sell - buy);
            fee = tradingFee.fmul(value);
            get = get.add(value).sub(fee);
        }
        require(pay <= maxPay, "max pay constraint violation");
        require(get >= minGet, "min get constraint violation");
        // 3. Settle tokens with the executor and collect the trading fee.
        if (pay > get) {
            token.uniTransferFromSenderToThis(pay - get);
        } else if (get > pay) {
            token.uniTransfer(msg.sender, get - pay);
        }
        uint256 reward = pikaRewardRatio.fmul(fee);
        pikaReward = pikaReward.add(reward);
        address beneficiary = referrerOf[msg.sender];
        if (beneficiary == address(0)) {
            require(referrer != msg.sender, "bad referrer");
            beneficiary = referrer;
            referrerOf[msg.sender] = referrer;
        }
        uint256 commission = 0;
        if (beneficiary != address(0)) {
            commission = referrerCommission.fmul(fee);
            commissionOf[beneficiary] = commissionOf[beneficiary].add(
                commission
            );
            insurance = insurance.add(
                fee.sub(commission).sub(reward).toInt256()
            );
        } else {
            insurance = insurance.add(fee.sub(reward).toInt256());
        }
        // 4. Check spot price and mark price consistency.
        uint256 spotPx = getSpotPx();
        emit Execute(
            msg.sender,
            actions,
            pay,
            get,
            fee,
            spotPx,
            mark,
            oracle.getPrice(),
            shift,
            insurance,
            commission,
            reward,
            now
        );
        require(spotPx.fmul(spotMarkThreshold) > mark, "slippage is too high");
        require(spotPx.fdiv(spotMarkThreshold) < mark, "slippage is too high");
    }

    /// @dev Open a long position of the contract, which is equivalent to opening a short position of the inverse pair.
    ///      For example, a long position of TOKEN/USD inverse contract can be viewed as short position of USD/TOKEN contract.
    /// @param size The size of the contract. One contract is close to 1 USD in value.
    /// @param strike The price which the leverage token is worth 0.
    /// @param minGet The minimum get value in TOKEN the caller is willing to take.
    /// @param referrer The address that refers this trader. Only relevant on the first call.
    function openLong(
        uint256 size,
        uint256 strike,
        uint256 minGet,
        address referrer
    ) external payable returns (uint256, uint256) {
        // Mint short token of USD/TOKEN pair
        return
            execute(
                PerpLib.getTradeAction(MintShort, size, strike),
                uint256(-1),
                minGet,
                referrer
            );
    }

    /// @dev Close a long position of the contract, which is equivalent to closing a short position of the inverse pair.
    /// @param size The size of the contract. One contract is close to 1 USD in value.
    /// @param strike The price which the leverage token is worth 0.
    /// @param maxPay The maximum pay size in leveraged token the caller is willing to commit.
    /// @param referrer The address that refers this trader. Only relevant on the first call.
    function closeLong(
        uint256 size,
        uint256 strike,
        uint256 maxPay,
        address referrer
    ) external returns (uint256, uint256) {
        // Burn short token of USD/TOKEN pair
        return
            execute(
                PerpLib.getTradeAction(BurnShort, size, strike),
                maxPay,
                0,
                referrer
            );
    }

    /// @dev Open a SHORT position of the contract, which is equivalent to opening a long position of the inverse pair.
    ///      For example, a short position of TOKEN/USD inverse contract can be viewed as long position of USD/ETH contract.
    /// @param size The size of the contract. One contract is close to 1 USD in value.
    /// @param strike The price which the leverage token is worth 0.
    /// @param maxPay The maximum pay value in TOKEN the caller is willing to commit.
    /// @param referrer The address that refers this trader. Only relevant on the first call.
    function openShort(
        uint256 size,
        uint256 strike,
        uint256 maxPay,
        address referrer
    ) external payable returns (uint256, uint256) {
        // Mint long token of USD/TOKEN pair
        return
            execute(
                PerpLib.getTradeAction(MintLong, size, strike),
                maxPay,
                0,
                referrer
            );
    }

    /// @dev Close a long position of the contract, which is equivalent to closing a short position of the inverse pair.
    /// @param size The size of the contract. One contract is close to 1 USD in value.
    /// @param strike The price which the leverage token is worth 0.
    /// @param minGet The minimum get value in TOKEN the caller is willing to take.
    /// @param referrer The address that refers this trader. Only relevant on the first call.
    function closeShort(
        uint256 size,
        uint256 strike,
        uint256 minGet,
        address referrer
    ) external returns (uint256, uint256) {
        // Burn long token of USD/TOKEN pair
        return
            execute(
                PerpLib.getTradeAction(BurnLong, size, strike),
                uint256(-1),
                minGet,
                referrer
            );
    }

    /// @dev Collect trading commission for the caller.
    /// @param amount The amount of commission to collect.
    function collect(uint256 amount) external nonReentrant {
        commissionOf[msg.sender] = commissionOf[msg.sender].sub(amount);
        token.uniTransfer(msg.sender, amount);
        emit Collect(msg.sender, amount);
    }

    /// @dev Deposit more funds to the insurance pool.
    /// @param amount The amount of funds to deposit.
    function deposit(uint256 amount) external nonReentrant {
        token.uniTransferFromSenderToThis(amount);
        insurance = insurance.add(amount.toInt256());
        emit Deposit(msg.sender, amount);
    }

    /// @dev Withdraw some insurance funds. Can only be called by the guardian.
    /// @param amount The amount of funds to withdraw.
    function withdraw(uint256 amount) external nonReentrant {
        require(msg.sender == guardian, "not the guardian");
        insurance = insurance.sub(amount.toInt256());
        require(insurance > 0, "negative insurance after withdrawal");
        token.uniTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount);
    }

    /// @dev Update the mark price, computed as average spot prices with decay.
    /// @param timeElapsed The number of seconds since last mark price update.
    function _updateMark(uint256 timeElapsed) internal {
        mark = getMark(timeElapsed);
    }

    /// @dev Update the shift price shift factor.
    /// @param timeElapsed The number of seconds since last shift update.
    function _updateShift(uint256 timeElapsed) internal {
        uint256 index = oracle.getPrice();
        int256 change = 0;
        uint256 ratio = mark > index
            ? (mark.sub(index)).fdiv(index)
            : (index.sub(mark)).fdiv(index);
        if (ratio < fundingAdjustThreshold) {
            return;
        }
        if (mark > index) {
            // shift spot price to lower
            change = mark.mul(timeElapsed).toInt256().mul(-1).fmul(
                ratio.div(uint256(1 days))
            );
        } else {
            // shift spot price to higher
            change = mark.mul(timeElapsed).toInt256().fmul(
                ratio.div(uint256(1 days))
            );
        }
        int256 prevShift = shift;
        int256 nextShift = prevShift.add(change);
        int256 prevExtra = prevShift.fmul(reserve).sub(
            prevShift.fmul(reserve0)
        );
        int256 nextExtra = nextShift.fmul(reserve).sub(
            nextShift.fmul(reserve0)
        );
        insurance = insurance.add(nextExtra.sub(prevExtra));
        shift = nextShift;
    }

    /// @dev Update the slot boundary variable and perform kill on bad slots.
    function _moveSlots() internal {
        // Handle long side
        uint256 _prevMaxSafeLongSlot = maxSafeLongSlot;
        uint256 _nextMaxSafeLongSlot = PerpLib.getSlot(
            mark.fmul(safeThreshold)
        );
        while (_prevMaxSafeLongSlot > _nextMaxSafeLongSlot) {
            uint256 strike = PerpLib.getStrike(_prevMaxSafeLongSlot);
            uint256 ident = getLongIdent(_prevMaxSafeLongSlot);
            uint256 size = supplyOf[ident];
            emit Liquidate(ident, size);
            burden = burden.add(size.toInt256());
            insurance = insurance.sub(size.fmul(strike).toInt256());
            longOffsetOf[_prevMaxSafeLongSlot]++;
            _prevMaxSafeLongSlot--;
        }
        maxSafeLongSlot = _nextMaxSafeLongSlot;
        // Handle short side
        uint256 _prevMinSafeShortSlot = minSafeShortSlot;
        uint256 _nextMinSafeShortSlot = PerpLib
            .getSlot(mark.fdiv(safeThreshold))
            .add(1);
        while (_prevMinSafeShortSlot < _nextMinSafeShortSlot) {
            uint256 strike = PerpLib.getStrike(_prevMinSafeShortSlot);
            uint256 ident = getShortIdent(_prevMinSafeShortSlot);
            uint256 size = supplyOf[ident];
            emit Liquidate(ident, size);
            burden = burden.sub(size.toInt256());
            insurance = insurance.add(size.fmul(strike).toInt256());
            shortOffsetOf[_prevMinSafeShortSlot]++;
            _prevMinSafeShortSlot++;
        }
        minSafeShortSlot = _nextMinSafeShortSlot;
    }

    /// @dev Use insurance fund to the burden up to the limit to bring burden to zero.
    function _liquidate(uint256 timeElapsed) internal {
        int256 prevBurden = burden;
        if (prevBurden > 0) {
            uint256 limit = liquidationPerSec.mul(timeElapsed);
            uint256 sell = MathUpgradeable.min(prevBurden.toUint256(), limit);
            uint256 get = _doSell(sell);
            totalOI = totalOI.sub(sell); // reduce open interest
            dailyVolume = dailyVolume.add(sell);
            insurance = insurance.add(get.toInt256());
            burden = prevBurden.sub(sell.toInt256());
        } else if (prevBurden < 0) {
            uint256 limit = liquidationPerSec.mul(timeElapsed);
            uint256 buy = MathUpgradeable.min(
                prevBurden.mul(-1).toUint256(),
                limit
            );
            uint256 pay = _doBuy(buy);
            totalOI = totalOI.add(buy); // reduce open interest
            dailyVolume = dailyVolume.add(buy);
            insurance = insurance.sub(pay.toInt256());
            burden = prevBurden.add(buy.toInt256());
        }
    }

    /// @dev Mint position tokens and returns the value of the debt involved. If the strike is 0, mint PIKA stablecoin.
    /// @param ident The identifier of position tokens to mint.
    /// @param size The amount of position tokens to mint.
    function _doMint(uint256 ident, uint256 size) internal returns (uint256) {
        totalOI = totalOI.add(size);
        dailyVolume = dailyVolume.add(size);
        uint256 strike = PerpLib.getStrike(ident);
        if (strike == 0) {
            IPika(pika).mint(msg.sender, size);
            return 0;
        }
        uint256 supply = supplyOf[ident];
        uint256 value = strike.fmul(supply.add(size)).sub(strike.fmul(supply));
        supplyOf[ident] = supply.add(size);
        _mint(msg.sender, ident, size, "");
        return value;
    }

    /// @dev Burn position tokens and returns the value of the debt involved. If the strike is 0, burn PIKA stablecoin.
    /// @param ident The identifier of position tokens to burn.
    /// @param size The amount of position tokens to burn.
    function _doBurn(uint256 ident, uint256 size) internal returns (uint256) {
        totalOI = totalOI.sub(size);
        dailyVolume = dailyVolume.add(size);
        uint256 strike = PerpLib.getStrike(ident);
        if (strike == 0) {
            IPika(pika).burn(msg.sender, size);
            return 0;
        }
        uint256 supply = supplyOf[ident];
        uint256 value = strike.fmul(supply.add(size)).sub(strike.fmul(supply));
        supplyOf[ident] = supply.sub(size);
        _burn(msg.sender, ident, size);
        return value;
    }

    /// @dev Buy virtual tokens and return the amount of quote tokens required.
    /// @param size The amount of tokens to buy.
    function _doBuy(uint256 size) internal returns (uint256) {
        uint256 nextReserve = reserve.sub(size);
        uint256 base = coeff.div(nextReserve).sub(coeff.div(reserve));
        int256 premium = shift.fmul(reserve).sub(shift.fmul(nextReserve));
        reserve = nextReserve;
        return base.toInt256().add(premium).toUint256();
    }

    /// @dev Sell virtual tokens and return the amount of quote tokens received.
    /// @param size The amount of tokens to sell.
    function _doSell(uint256 size) internal returns (uint256) {
        uint256 nextReserve = reserve.add(size);
        uint256 base = coeff.div(reserve).sub(coeff.div(nextReserve));
        int256 premium = shift.fmul(nextReserve).sub(shift.fmul(reserve));
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
        uint256 timeElapsed = now - lastTwapOIChangeTime;
        smallDecayTwapOI = smallDecayTwapOI == 0
            ? totalOI
            : PerpLib.getTwapOI(
                timeElapsed,
                smallDecayTwapOI,
                smallOIDecayPerSecond,
                totalOI
            );
        largeDecayTwapOI = largeDecayTwapOI == 0
            ? totalOI
            : PerpLib.getTwapOI(
                timeElapsed,
                largeDecayTwapOI,
                largeOIDecayPerSecond,
                totalOI
            );
        lastTwapOIChangeTime = now;
    }

    /// @dev Update liquidity dynamically based on open interest change.
    function _updateLiquidityByOI() internal {
        if (smallDecayTwapOI == 0 || smallDecayTwapOI == 0) {
            return;
        }
        uint256 timeElapsed = now - lastLiquidityChangeTime;
        uint256 change = coeff.mul(timeElapsed).fmul(liquidityChangePerSec);
        if (smallDecayTwapOI.fdiv(largeDecayTwapOI) > OIChangeThreshold) {
            // Since recent OI increased, increase liquidity.
            uint256 nextCoeff = coeff.add(change);
            uint256 nextReserve = (nextCoeff.fdiv(getSpotPx())).sqrt();
            uint256 nextReserve0 = nextReserve.add(reserve0).sub(reserve);
            _setLiquidity(nextCoeff, nextReserve0);
        } else if (
            largeDecayTwapOI.fdiv(smallDecayTwapOI) > OIChangeThreshold
        ) {
            // Since recent OI decreased, decrease liquidity.
            uint256 nextCoeff = coeff.sub(change);
            uint256 nextReserve = (nextCoeff.fdiv(getSpotPx())).sqrt();
            uint256 nextReserve0 = nextReserve.add(reserve0).sub(reserve);
            _setLiquidity(nextCoeff, nextReserve0);
        }
        lastLiquidityChangeTime = now;
    }

    /// @dev Update liquidity dynamically based on 24 hour trading volume change.
    function _updateLiquidityByVolume() internal {
        if (
            now - lastDailyVolumeUpdateTime < 24 hours ||
            prevDailyVolume == 0 ||
            dailyVolume == 0
        ) {
            return;
        }
        uint256 change = coeff.mul(now - lastDailyVolumeUpdateTime).fmul(
            liquidityChangePerSec
        );
        if (dailyVolume.fdiv(prevDailyVolume) > volumeChangeThreshold) {
            uint256 nextCoeff = coeff.add(change);
            uint256 nextReserve = (nextCoeff.fdiv(getSpotPx())).sqrt();
            uint256 nextReserve0 = nextReserve.add(reserve0).sub(reserve);
            _setLiquidity(nextCoeff, nextReserve0);
        } else if (prevDailyVolume.fdiv(dailyVolume) > volumeChangeThreshold) {
            uint256 nextCoeff = coeff.sub(change);
            uint256 nextReserve = (nextCoeff.fdiv(getSpotPx())).sqrt();
            uint256 nextReserve0 = nextReserve.add(reserve0).sub(reserve);
            _setLiquidity(nextCoeff, nextReserve0);
        }
    }

    /// @dev Update liquidity factors, using insurance fund to maintain invariants.
    /// @param nextCoeff The new coeefficient value.
    /// @param nextReserve0 The new reserve0 value.
    function _setLiquidity(uint256 nextCoeff, uint256 nextReserve0) internal {
        uint256 nextReserve = nextReserve0.add(reserve).sub(reserve0);
        int256 prevVal = coeff.div(reserve).toInt256().sub(
            coeff.div(reserve0).toInt256()
        );
        int256 nextVal = nextCoeff.div(nextReserve).toInt256().sub(
            nextCoeff.div(nextReserve0).toInt256()
        );
        emit LiquidityChanged(
            coeff,
            reserve0,
            reserve,
            nextCoeff,
            nextReserve0,
            nextReserve,
            prevVal.sub(nextVal)
        );
        insurance = insurance.add(prevVal).sub(nextVal);
        coeff = nextCoeff;
        reserve0 = nextReserve0;
        reserve = nextReserve;
    }

    function distributeReward() external override returns (uint256) {
        require(
            msg.sender == rewardDistributor,
            "sender is not rewardDistributor"
        );
        if (pikaReward > 0) {
            uint256 distributedReward = pikaReward;
            pikaReward = 0;
            token.uniTransfer(rewardDistributor, distributedReward);
            emit RewardDistribute(rewardDistributor, distributedReward);
            return distributedReward;
        }
        return 0;
    }

    // ============ Getter Functions ============

    /// @dev Return the active ident (slot with offset) for the given long price slot. The long refers to USD/TOKEN pair.
    /// @param slot The price slot to query.
    function getLongIdent(uint256 slot) public view returns (uint256) {
        require(slot < (1 << 16), "bad slot");
        return (1 << 255) | (longOffsetOf[slot] << 16) | slot;
    }

    /// @dev Return the active ident (slot with offset) for the given short price slot. The short refers to USD/TOKEN pair.
    /// @param slot The price slot to query.
    function getShortIdent(uint256 slot) public view returns (uint256) {
        require(slot < (1 << 16), "bad slot");
        return (shortOffsetOf[slot] << 16) | slot;
    }

    /// @dev Return the current user position of leveraged token for a strike.
    /// @param account Address of a user.
    /// @param strike The price which the leverage token is worth 0.
    /// @param isLong Whether is long or short in terms of TOKEN/USD pair.
    function getPosition(
        address account,
        uint256 strike,
        bool isLong
    ) public view returns (uint256) {
        uint256 slot = PerpLib.getSlot(strike);
        uint256 ident = isLong ? getShortIdent(slot) : getLongIdent(slot);
        return balanceOf(account, ident);
    }

    /// @dev Return the current approximate spot price of this perp market.
    function getSpotPx() public view returns (uint256) {
        uint256 px = coeff.div(reserve).fdiv(reserve);
        return px.toInt256().add(shift).toUint256();
    }

    /// @dev Get strike price from target leverage
    /// @param leverage The leverage of the position.
    /// @param isLong Whether is long or short in terms of TOKEN/USD pair.
    function getStrikeFromLeverage(uint256 leverage, bool isLong)
        public
        view
        returns (uint256)
    {
        uint256 latestMark = getLatestMark();
        if (isLong) {
            return latestMark.add(latestMark.fdiv(leverage));
        }
        return latestMark.sub(latestMark.fdiv(leverage));
    }

    /// @dev Get the mark price, computed as average spot prices with decay.
    /// @param timeElapsed The number of seconds since last mark price update.
    function getMark(uint256 timeElapsed) public view returns (uint256) {
        uint256 total = 1e18;
        uint256 each = decayPerSecond;
        while (timeElapsed > 0) {
            if (timeElapsed & 1 != 0) {
                total = total.fmul(each);
            }
            each = each.fmul(each);
            timeElapsed = timeElapsed >> 1;
        }
        uint256 prev = total.fmul(mark);
        uint256 next = uint256(1e18).sub(total).fmul(getSpotPx());
        return prev.add(next);
    }

    /// @dev Get the latest mark price, computed as average spot prices with decay.
    function getLatestMark() public view returns (uint256) {
        uint256 timeElapsed = now - lastPoke;
        if (timeElapsed > 0) {
            return getMark(timeElapsed);
        }
        return mark;
    }

    /// @dev Get the reward that has not been distributed.
    function getPendingReward() external view override returns (uint256) {
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
    function setRewardDistributor(address payable newRewardDistributor)
        external
        onlyGovernor
    {
        rewardDistributor = newRewardDistributor;
    }

    function setLiquidity(uint256 nextCoeff, uint256 nextReserve0)
        external
        onlyGovernor
    {
        _setLiquidity(nextCoeff, nextReserve0);
    }

    /// @dev Set market status for this perpetual market.
    /// @param _status The new market status.
    function setMarketStatus(MarketStatus _status) external onlyGovernor {
        status = _status;
    }

    // @dev setters for per second parameters. Combine the setters to one function to reduce contract size.
    function setParametersPerSec(
        uint256 newLiquidationPerSec,
        uint256 newDecayPerSecond,
        uint256 newLiquidityChangePerSec
    ) external onlyGovernor {
        liquidationPerSec = newLiquidationPerSec;
        decayPerSecond = newDecayPerSecond;
        liquidityChangePerSec = newLiquidityChangePerSec;
    }

    // @dev setters for thresholds parameters. Combine the setters to one function to reduce contract size.
    function setThresholds(
        uint256 newFundingAdjustThreshold,
        uint256 newSafeThreshold,
        uint256 newSpotMarkThreshold,
        uint256 newOIChangeThreshold,
        uint256 newVolumeChangeThreshold
    ) external onlyGovernor {
        fundingAdjustThreshold = newFundingAdjustThreshold;
        safeThreshold = newSafeThreshold;
        spotMarkThreshold = newSpotMarkThreshold;
        OIChangeThreshold = newOIChangeThreshold;
        volumeChangeThreshold = newVolumeChangeThreshold;
    }

    function setTradingFee(uint256 newTradingFee) external onlyGovernor {
        tradingFee = newTradingFee;
    }

    function setReferrerCommission(uint256 newReferrerCommission)
        external
        onlyGovernor
    {
        referrerCommission = newReferrerCommission;
    }

    function setPikaRewardRatio(uint256 newPikaRewardRatio)
        external
        onlyGovernor
    {
        pikaRewardRatio = newPikaRewardRatio;
    }

    function setMaxPokeElapsed(uint256 newMaxPokeElapsed)
        external
        onlyGovernor
    {
        maxPokeElapsed = newMaxPokeElapsed;
    }

    function setDynamicLiquidity(bool isDynamicByOI, bool isDynamicByVolume)
        external
        onlyGovernor
    {
        isLiquidityDynamicByOI = isDynamicByOI;
        isLiquidityDynamicByVolume = isDynamicByVolume;
    }

    function setOralce(address newOracle) external onlyGovernor {
        oracle = IOracle(newOracle);
    }
}
