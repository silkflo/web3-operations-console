// ethereum-v3/contracts/test/MaliciousAttacker.sol

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MaliciousAttacker
 * @notice Test contract that attempts reentrancy attacks on EthSplit
 * @dev Used exclusively in security tests to prove EthSplit's defenses
 *      This contract is NEVER deployed to production networks
 */
contract MaliciousAttacker {
    /// @notice The target EthSplit contract being attacked
    address public target;

    /// @notice Number of reentrant calls attempted
    uint256 public attackCount;

    /// @notice Whether the attack is active
    bool public attacking;

    /// @notice Tracks if attack succeeded
    bool public attackSucceeded;

    /// @notice Fallback function that attempts reentrancy
    receive() external payable {
        if (attacking && attackCount < 10) {
            attackCount++;

            // Try to withdraw again (reentrancy attempt)
            (bool success, ) = target.call(
                abi.encodeWithSignature("withdraw()")
            );

            if (success) {
                attackSucceeded = true;
            }
        }
        // If not attacking, accept ETH normally
    }

    /**
     * @notice Begins the reentrancy attack
     * @param targetAddress The EthSplit contract to attack
     * @dev This function starts the attack by making an initial withdrawal
     */
    function attack(address targetAddress) external {
        target = targetAddress;
        attacking = true;
        attackCount = 0;
        attackSucceeded = false;

        // Initial withdrawal attempt
        (bool success, ) = target.call(
            abi.encodeWithSignature("withdraw()")
        );

        attacking = false;

        require(success, "Initial attack failed");
    }

    /**
     * @notice Returns the ETH balance of this attacker contract
     */
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @notice Allows withdrawal of any ETH from this contract
     * @dev For test cleanup only
     */
    function recoverFunds() external {
        payable(msg.sender).transfer(address(this).balance);
    }
}

/**
 * @title MaliciousReceiver
 * @notice Test contract that rejects ETH transfers
 * @dev Used to test EthSplit's withdrawal failure handling
 */
contract MaliciousReceiver {
    /// @notice Whether to reject incoming ETH
    bool public rejectEth = false;

    /// @notice Toggle ETH rejection on/off
    function setRejectEth(bool _reject) external {
        rejectEth = _reject;
    }

    /// @notice Rejects ETH when rejectEth is true
    receive() external payable {
        if (rejectEth) {
            revert("I reject ETH");
        }
    }

    /// @notice Joins a split and then tries to withdraw
    /// @dev The withdrawal should fail because receive() reverts
    function joinAndWithdraw(address splitAddress) external {
        // Join the split
        (bool joinSuccess, ) = splitAddress.call(
            abi.encodeWithSignature("join()")
        );
        require(joinSuccess, "Join failed");

        // Enable ETH rejection before withdrawal
        rejectEth = true;

        // Try to withdraw (will fail because receive reverts)
        (bool withdrawSuccess, ) = splitAddress.call(
            abi.encodeWithSignature("withdraw()")
        );

        // Withdrawal should fail
        require(!withdrawSuccess, "Withdrawal should have failed");
    }
}
