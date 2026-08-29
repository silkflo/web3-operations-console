// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title EthSplit
 * @notice A pull-payment ETH splitting contract with multiple funding rounds
 * @dev Demonstrates production-grade Solidity patterns including:
 *      - Checks-effects-interactions
 *      - Pull payments over push payments
 *      - Reentrancy protection
 *      - Custom errors for gas efficiency
 *      - Complete NatSpec documentation
 *
 * @dev Security notes:
 *      - This contract is for demonstration on Sepolia testnet only
 *      - It has NOT received a professional external audit
 *      - No server-side keys or autonomous execution capabilities exist
 */
contract EthSplit {
    /// @notice Maximum number of participants allowed per funding round
    uint256 public constant MAX_PARTICIPANTS = 50;

    /// @notice Semantic version of the contract
    string public constant VERSION = "3.0.0";

    /// @notice Address that can fund and finalize distribution rounds
    address public immutable manager;

    /// @notice Human-readable title for this split instance
    string public title;

    /// @dev Internal list of participants for the current round
    address[] private participantsList;

    /// @notice Whether an address is currently a participant in the active round
    mapping(address => bool) public isParticipant;

    /// @notice Amount of ETH an address can withdraw from completed rounds
    mapping(address => uint256) public claimable;

    /// @notice Number of participants in the current round
    uint256 public participantCount;

    /// @notice Current funding round number (starts at 1)
    uint256 public round;

    /// @notice ETH funded for the current round and not yet allocated
    uint256 public roundPool;

    /// @notice ETH allocated to participants but not yet withdrawn
    uint256 public totalClaimable;

    /// @dev Reentrancy guard state variable
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private reentrancyGuard;

    // ============ CUSTOM ERRORS ============

    /// @notice Thrown when a non-manager attempts a manager-only action
    /// @param caller The address that attempted the action
    error OnlyManager(address caller);

    /// @notice Thrown when the manager tries to join their own split
    error ManagerCannotJoin();

    /// @notice Thrown when an address tries to join a round twice
    /// @param participant The address that attempted to rejoin
    error AlreadyJoined(address participant);

    /// @notice Thrown when the participant limit has been reached
    /// @param limit The maximum number of participants
    error ParticipantLimitReached(uint256 limit);

    /// @notice Thrown when funding is attempted with zero ETH
    error ZeroFundingAmount();

    /// @notice Thrown when finalization is attempted with no participants
    error NoParticipants();

    /// @notice Thrown when finalization is attempted with no ETH funded
    error NoRoundFunding();

    /// @notice Thrown when the funded amount is too small to distribute evenly
    /// @param pool The amount funded in the current round
    /// @param count The number of participants
    error InsufficientDistributionAmount(uint256 pool, uint256 count);

    /// @notice Thrown when withdrawal is attempted with no claimable balance
    /// @param participant The address that attempted withdrawal
    error NothingToWithdraw(address participant);

    /// @notice Thrown when an ETH transfer fails
    /// @param recipient The intended recipient
    /// @param amount The amount that failed to transfer
    error WithdrawalFailed(address recipient, uint256 amount);

    /// @notice Thrown when a zero address is used where a valid address is required
    error InvalidAddress();

    /// @notice Thrown when a title is empty
    error EmptyTitle();

    // ============ EVENTS ============

    /// @notice Emitted when a participant joins the current round
    /// @param participant The address that joined
    /// @param round The round number they joined
    /// @param participantCount The total participants after joining
    event ParticipantJoined(
        address indexed participant,
        uint256 indexed round,
        uint256 participantCount
    );

    /// @notice Emitted when the manager funds the current round
    /// @param manager The manager address
    /// @param round The round number being funded
    /// @param amount The ETH amount funded
    /// @param roundPoolTotal The total pool after funding
    event Funded(
        address indexed manager,
        uint256 indexed round,
        uint256 amount,
        uint256 roundPoolTotal
    );

    /// @notice Emitted when the manager finalizes distribution for the current round
    /// @param round The round being finalized
    /// @param totalDistributed Total ETH allocated to participants
    /// @param participantCount Number of participants receiving funds
    /// @param amountPerParticipant ETH allocated per participant
    /// @param remainderRemaining Dust left in the pool for future rounds
    event DistributionFinalized(
        uint256 indexed round,
        uint256 totalDistributed,
        uint256 participantCount,
        uint256 amountPerParticipant,
        uint256 remainderRemaining
    );

    /// @notice Emitted when a participant withdraws claimable ETH
    /// @param participant The address withdrawing
    /// @param amount The ETH amount withdrawn
    /// @param remainingClaimable The participant's remaining claimable balance
    event Withdrawal(
        address indexed participant,
        uint256 amount,
        uint256 remainingClaimable
    );

    // ============ MODIFIERS ============

    /**
     * @notice Restricts function access to the contract manager
     * @dev Uses custom error for gas efficiency
     */
    modifier onlyManager() {
        if (msg.sender != manager) {
            revert OnlyManager(msg.sender);
        }
        _;
    }

    /**
     * @notice Prevents reentrant calls to protected functions
     * @dev Standard OpenZeppelin-style mutex pattern
     */
    modifier nonReentrant() {
        if (reentrancyGuard == ENTERED) {
            revert("ReentrancyGuard: reentrant call");
        }
        reentrancyGuard = ENTERED;
        _;
        reentrancyGuard = NOT_ENTERED;
    }

    // ============ CONSTRUCTOR ============

    /**
     * @notice Deploys a new EthSplit contract
     * @param contractTitle Human-readable name for this split
     * @param creator Address that becomes the manager
     * @dev The creator becomes the permanent manager of this contract
     */
    constructor(
        string memory contractTitle,
        address creator
    ) {
        if (creator == address(0)) {
            revert InvalidAddress();
        }
        if (bytes(contractTitle).length == 0) {
            revert EmptyTitle();
        }

        manager = creator;
        title = contractTitle;
        round = 1;
        reentrancyGuard = NOT_ENTERED;
    }

    // ============ EXTERNAL FUNCTIONS ============

    /**
     * @notice Allows any address (except the manager) to join the current round
     * @dev Participants must rejoin for each new round
     * - Reverts if the caller is the manager
     * - Reverts if the caller has already joined
     * - Reverts if the participant limit is reached
     */
    function join() external {
        if (msg.sender == manager) {
            revert ManagerCannotJoin();
        }
        if (isParticipant[msg.sender]) {
            revert AlreadyJoined(msg.sender);
        }
        if (participantCount >= MAX_PARTICIPANTS) {
            revert ParticipantLimitReached(MAX_PARTICIPANTS);
        }

        isParticipant[msg.sender] = true;
        participantsList.push(msg.sender);
        participantCount++;

        emit ParticipantJoined(
            msg.sender,
            round,
            participantCount
        );
    }

    /**
     * @notice Allows the manager to fund the current round with ETH
     * @dev The ETH is held by the contract until distribution is finalized
     * - Can be called multiple times before finalization
     * - Uses pull-payment pattern; funds are never pushed to participants
     */
    function fund() external payable onlyManager {
        if (msg.value == 0) {
            revert ZeroFundingAmount();
        }

        roundPool += msg.value;

        emit Funded(
            msg.sender,
            round,
            msg.value,
            roundPool
        );
    }

    /**
     * @notice Finalizes the current round by distributing funded ETH equally
     * @dev Implements checks-effects-interactions pattern:
     *      1. All state updates happen first
     *      2. No external calls are made during state changes
     *      - Participants must rejoin for subsequent rounds
     *      - Dust from division remainder stays in the pool
     */
    function finalizeDistribution()
        external
        onlyManager
    {
        if (participantCount == 0) {
            revert NoParticipants();
        }
        if (roundPool == 0) {
            revert NoRoundFunding();
        }

        uint256 currentRound = round;
        uint256 count = participantCount;
        uint256 amountPerParticipant = roundPool / count;

        if (amountPerParticipant == 0) {
            revert InsufficientDistributionAmount(
                roundPool,
                count
            );
        }

        uint256 totalDistributed =
            amountPerParticipant * count;

        // Update state for each participant
        for (uint256 i = 0; i < participantsList.length; i++) {
            address participant = participantsList[i];
            claimable[participant] += amountPerParticipant;
            isParticipant[participant] = false;
        }

        totalClaimable += totalDistributed;
        roundPool -= totalDistributed;

        // Reset for next round
        delete participantsList;
        participantCount = 0;
        round++;

        emit DistributionFinalized(
            currentRound,
            totalDistributed,
            count,
            amountPerParticipant,
            roundPool
        );
    }

    /**
     * @notice Allows participants to withdraw their claimable ETH
     * @dev Implements checks-effects-interactions with reentrancy protection:
     *      1. State is updated before external calls
     *      2. ReentrancyGuard prevents recursive calls
     *      - Uses `.call()` with explicit failure handling
     */
    function withdraw() external nonReentrant {
        uint256 amount = claimable[msg.sender];

        if (amount == 0) {
            revert NothingToWithdraw(msg.sender);
        }

        // State updates before external call
        claimable[msg.sender] = 0;
        totalClaimable -= amount;

        // External call after state updates
        (bool success, ) = payable(msg.sender).call{
            value: amount
        }("");

        if (!success) {
            revert WithdrawalFailed(msg.sender, amount);
        }

        emit Withdrawal(
            msg.sender,
            amount,
            0
        );
    }

    // ============ VIEW FUNCTIONS ============

    /**
     * @notice Returns the list of participants in the current round
     * @return address[] Array of participant addresses
     * @dev Only returns current round participants
     */
    function getParticipants()
        external
        view
        returns (address[] memory)
    {
        return participantsList;
    }

    /**
     * @notice Returns the total ETH balance held by this contract
     * @return uint256 Contract balance in wei
     * @dev Includes both claimable and unallocated round pool funds
     */
    function contractBalance()
        external
        view
        returns (uint256)
    {
        return address(this).balance;
    }

    /**
     * @notice Returns the amount available for distribution in the current round
     * @return uint256 Current round pool in wei
     */
    function availableForDistribution()
        external
        view
        returns (uint256)
    {
        return roundPool;
    }

    /**
     * @notice Returns the claimable balance for a specific address
     * @param participant Address to check
     * @return uint256 Amount claimable in wei
     * @dev Use this instead of the public mapping for better interface
     */
    function getClaimable(
        address participant
    ) external view returns (uint256) {
        return claimable[participant];
    }

    /**
     * @notice Returns contract metadata for frontend and indexer use
     * @return version Contract version string
     * @return managerAddress Manager address
     * @return currentRound Current round number
     * @return currentParticipantCount Active participants count
     */
    function getContractInfo()
        external
        view
        returns (
            string memory version,
            address managerAddress,
            uint256 currentRound,
            uint256 currentParticipantCount
        )
    {
        return (
            VERSION,
            manager,
            round,
            participantCount
        );
    }
}
