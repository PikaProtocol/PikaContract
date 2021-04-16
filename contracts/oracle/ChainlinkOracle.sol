// SPDX-License-Identifier: MIT

pragma solidity ^0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";
import "./IOracle.sol";

contract ChainlinkOracle is IOracle {
    using SafeMath for uint256;

    uint256 public constant BASE = 1e18;

    AggregatorV3Interface public priceFeed;
    bool public isInverse;

    constructor(address _priceFeedAddress, bool _isInverse) public {
        priceFeed = AggregatorV3Interface(_priceFeedAddress);
        isInverse = _isInverse;
    }

    /**
     * Returns the latest price
     */
    function getPrice() public view override returns (uint256) {
        (, int256 price, , uint256 timestamp, ) = priceFeed.latestRoundData();
        require(timestamp > 0, "Round not complete");
        require(price > 0, "Price is not > 0");

        uint256 decimals = uint256(priceFeed.decimals());
        uint256 adjustedPrice = uint256(price).mul(BASE).div(10**decimals);
        if (isInverse) {
            return BASE.mul(BASE).div(adjustedPrice);
        }
        return adjustedPrice;
    }
}
