// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

library PerpLib {

	/// @dev Convert the given strike price to its slot, round down.
	/// @param strike The strike price to convert.
	function getSlot(uint strike) internal pure returns (uint) {
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
	function getStrike(uint ident) internal pure returns (uint) {
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
}
