// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import '@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol';
import '../lib/PerpMath.sol';

library PerpLib {
	using PerpMath for uint;
	using PerpMath for int;
	using SafeMathUpgradeable for uint;

	/// @dev Convert the given strike price to its slot, round down.
	/// @param strike The strike price to convert.
	function getSlot(uint strike) internal pure returns (uint) {
		if (strike < 100) return strike.add(800);
		uint magnitude = 1;
		while (strike >= 1000) {
			magnitude = magnitude.add(1);
			strike = strike.div(10);
		}
		return magnitude.mul(900).add(strike).sub(100);
	}

	/// @dev Convert the given slot identifier to strike price.
	/// @param ident The slot identifier, can be with or without the offset.
	function getStrike(uint ident) internal pure returns (uint) {
		uint slot = ident & ((1 << 16) - 1); // only consider the last 16 bits
		uint prefix = slot.mod(900); // maximum value is 899
		uint magnitude = slot.div(900); // maximum value is 72
		if (magnitude == 0) {
			require(prefix >= 800, 'bad prefix');
			return prefix.sub(800);
		} else {
			return (prefix.add(100)) * (10**(magnitude.sub(1))); // never overflow
		}
	}

	/// @dev Get the total open interest, computed as average open interest with decay.
	/// @param timeElapsed The number of seconds since last open interest update.
	/// @param prevDecayTwapOI The TWAP open interest from the last update.
	/// @param oiDecayPerSecond The exponential TWAP decay for open interest every second.
	/// @param currentOI The current total open interest.
	function getTwapOI(uint timeElapsed, uint prevDecayTwapOI, uint oiDecayPerSecond, uint currentOI) internal pure returns (uint) {
		uint total = 1e18;
		uint each = oiDecayPerSecond;
		while (timeElapsed > 0) {
			if (timeElapsed & 1 != 0) {
				total = total.fmul(each);
			}
			each = each.fmul(each);
			timeElapsed = timeElapsed >> 1;
		}
		uint prev = total.fmul(prevDecayTwapOI);
		uint next = uint(1e18).sub(total).fmul(currentOI);
		return prev.add(next);
	}
}
