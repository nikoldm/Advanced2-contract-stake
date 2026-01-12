// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MetaNodeStake.sol";

contract MetaNodeStakeV2 is MetaNodeStake {
    // 添加新功能
    uint256 public newVersionVariable;

    function setNewVersionVariable(
        uint256 _value
    ) external onlyRole(ADMIN_ROLE) {
        newVersionVariable = _value;
    }

    function getVersion() external pure returns (string memory) {
        return "V2.0";
    }
}
