//SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

import '@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/utils/SafeCastUpgradeable.sol';

library PerpMath {
	using SafeCastUpgradeable for uint;
	using SafeMathUpgradeable for uint;
	using SignedSafeMathUpgradeable for int;

	function fmul(uint lhs, uint rhs) internal pure returns (uint) {
		return lhs.mul(rhs) / 1e18;
	}

	function fdiv(uint lhs, uint rhs) internal pure returns (uint) {
		return lhs.mul(1e18) / rhs;
	}

	function fmul(int lhs, uint rhs) internal pure returns (int) {
		return lhs.mul(rhs.toInt256()) / 1e18;
	}

	function fdiv(int lhs, uint rhs) internal pure returns (int) {
		return lhs.mul(1e18) / rhs.toInt256();
	}
}
