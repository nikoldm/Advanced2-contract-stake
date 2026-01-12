// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * 升级版的质押挖矿合约：
 *   一个支持多币种质押的挖矿合约，用户质押代币获得MetaNode奖励。支持ETH和ERC20代币质押，
 * 具有权重分配、锁定期、管理员控制等功能
 */
contract MetaNodeStake is
    Initializable, // 可初始化
    UUPSUpgradeable, // UUPS升级模式
    PausableUpgradeable, // 可暂停
    AccessControlUpgradeable // 权限控制
{
    using SafeERC20 for IERC20;
    using Address for address;
    using Math for uint256;

    // ************************************** INVARIANT **************************************

    bytes32 public constant ADMIN_ROLE = keccak256("admin_role"); // 管理员角色
    bytes32 public constant UPGRADE_ROLE = keccak256("upgrade_role"); // 升级角色

    uint256 public constant ETH_PID = 0; // ETH资金池ID固定为0

    // ************************************** DATA STRUCTURE **************************************
    /*
    Basically, any point in time, the amount of MetaNodes entitled to a user but is pending to be distributed is:

    pending MetaNode = (user.stAmount * pool.accMetaNodePerST) - user.finishedMetaNode

    Whenever a user deposits or withdraws staking tokens to a pool. Here's what happens:
    1. The pool's `accMetaNodePerST` (and `lastRewardBlock`) gets updated.
    2. User receives the pending MetaNode sent to his/her address.
    3. User's `stAmount` gets updated.
    4. User's `finishedMetaNode` gets updated.
    */
    // 资金池结构
    struct Pool {
        // Address of staking token
        // 质押代币的地址
        address stTokenAddress;
        // Weight of pool
        // 不同资金池所占的权重，用于分配奖励
        uint256 poolWeight;
        // Last block number that MetaNodes distribution occurs for pool
        // 上次分配奖励的区块
        uint256 lastRewardBlock;
        // Accumulated MetaNodes per staking token of pool
        // 质押 1个ETH经过1个区块高度，能拿到 n 个MetaNode，即累计每质押代币可获得的MetaNode（精度1e18）
        uint256 accMetaNodePerST;
        // Staking token amount
        // 质押的代币数量，池中总质押量
        uint256 stTokenAmount;
        // Min staking amount
        // 最小质押数量
        uint256 minDepositAmount;
        // Withdraw locked blocks
        // Unstake locked blocks 解质押锁定的区块高度
        uint256 unstakeLockedBlocks;
    }

    //  解质押请求结构
    struct UnstakeRequest {
        // Request withdraw amount
        uint256 amount; // 用户取消质押的代币数量，要取出多少个 token
        // The blocks when the request withdraw amount can be released
        uint256 unlockBlocks; // 解质押的区块高度
    }

    struct User {
        // 记录用户相对每个资金池 的质押记录
        // Staking token amount that user provided
        // 用户在当前资金池，质押的代币数量
        uint256 stAmount;
        // Finished distributed MetaNodes to user 最终 MetaNode 得到的数量
        // 用户在当前资金池，已经领取的 MetaNode 数量
        uint256 finishedMetaNode;
        // Pending to claim MetaNodes 当前可取数量
        // 用户在当前资金池，当前可领取的 MetaNode 数量
        uint256 pendingMetaNode;
        // Withdraw request list
        // 用户在当前资金池，取消质押的记录。解质押请求列表
        UnstakeRequest[] requests;
    }

    // ************************************** STATE VARIABLES 状态变量**************************************
    // First block that MetaNodeStake will start from
    uint256 public startBlock; // 质押开始区块高度
    // First block that MetaNodeStake will end from
    uint256 public endBlock; // 质押结束区块高度
    // MetaNode token reward per block
    uint256 public MetaNodePerBlock; // 每个区块高度，MetaNode 的奖励数量

    // Pause the withdraw function
    bool public withdrawPaused; // 是否暂停提现
    // Pause the claim function
    bool public claimPaused; // 是否暂停领取

    // MetaNode token
    IERC20 public MetaNode; // MetaNode 代币地址

    // Total pool weight / Sum of all pool weights
    uint256 public totalPoolWeight; // 所有资金池的权重总和
    Pool[] public pool; // 资金池列表

    // pool id => user address => user info
    mapping(uint256 => mapping(address => User)) public user; // 资金池 id => 用户地址 => 用户信息

    // ************************************** EVENT **************************************
    // 各种操作的事件，用于链上日志记录
    event SetMetaNode(IERC20 indexed MetaNode);

    event PauseWithdraw();

    event UnpauseWithdraw();

    event PauseClaim();

    event UnpauseClaim();

    event SetStartBlock(uint256 indexed startBlock);

    event SetEndBlock(uint256 indexed endBlock);

    event SetMetaNodePerBlock(uint256 indexed MetaNodePerBlock);

    event AddPool(
        address indexed stTokenAddress,
        uint256 indexed poolWeight,
        uint256 indexed lastRewardBlock,
        uint256 minDepositAmount,
        uint256 unstakeLockedBlocks
    );

    event UpdatePoolInfo(
        uint256 indexed poolId,
        uint256 indexed minDepositAmount,
        uint256 indexed unstakeLockedBlocks
    );

    event SetPoolWeight(
        uint256 indexed poolId,
        uint256 indexed poolWeight,
        uint256 totalPoolWeight
    );

    event UpdatePool(
        uint256 indexed poolId,
        uint256 indexed lastRewardBlock,
        uint256 totalMetaNode
    );

    event Deposit(address indexed user, uint256 indexed poolId, uint256 amount);

    event RequestUnstake(
        address indexed user,
        uint256 indexed poolId,
        uint256 amount
    );

    event Withdraw(
        address indexed user,
        uint256 indexed poolId,
        uint256 amount,
        uint256 indexed blockNumber
    );

    event Claim(
        address indexed user,
        uint256 indexed poolId,
        uint256 MetaNodeReward
    );

    // ************************************** MODIFIER 修饰器 **************************************
    // 检查池ID是否有效
    modifier checkPid(uint256 _pid) {
        require(_pid < pool.length, "invalid pid");
        _;
    }

    // 检查领取是否未暂停
    modifier whenNotClaimPaused() {
        require(!claimPaused, "claim is paused");
        _;
    }
    // 检查提现是否未暂停
    modifier whenNotWithdrawPaused() {
        require(!withdrawPaused, "withdraw is paused");
        _;
    }

    /**
     * @notice Set MetaNode token address. Set basic info when deploying.
     * @notice 初始化合约
     * @param _MetaNode MetaNode代币地址
     * @param _startBlock 开始区块
     * @param _endBlock 结束区块
     * @param _MetaNodePerBlock 每区块奖励数量
     */
    function initialize(
        IERC20 _MetaNode,
        uint256 _startBlock,
        uint256 _endBlock,
        uint256 _MetaNodePerBlock
    ) public initializer {
        require(
            _startBlock <= _endBlock && _MetaNodePerBlock > 0,
            "invalid parameters"
        );

        // 初始化基础合约
        __AccessControl_init();
        __UUPSUpgradeable_init();

        // 设置权限
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(UPGRADE_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);

        setMetaNode(_MetaNode); // 设置MetaNode代币

        // 设置基本参数
        startBlock = _startBlock;
        endBlock = _endBlock;
        MetaNodePerBlock = _MetaNodePerBlock;
    }

    // UUPS升级授权函数
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADE_ROLE) {}

    // ************************************** ADMIN FUNCTION **************************************

    /**
     * @notice 设置MetaNode代币地址。Set MetaNode token address. Can only be called by admin
     */
    function setMetaNode(IERC20 _MetaNode) public onlyRole(ADMIN_ROLE) {
        MetaNode = _MetaNode;

        emit SetMetaNode(MetaNode);
    }

    /**
     * @notice Pause withdraw. Can only be called by admin. 暂停提现功能
     */
    function pauseWithdraw() public onlyRole(ADMIN_ROLE) {
        require(!withdrawPaused, "withdraw has been already paused");

        withdrawPaused = true;

        emit PauseWithdraw();
    }

    /**
     * @notice Unpause withdraw. Can only be called by admin. 恢复提现功能
     */
    function unpauseWithdraw() public onlyRole(ADMIN_ROLE) {
        require(withdrawPaused, "withdraw has been already unpaused");

        withdrawPaused = false;

        emit UnpauseWithdraw();
    }

    /**
     * @notice Pause claim. Can only be called by admin. 暂停领取功能
     */
    function pauseClaim() public onlyRole(ADMIN_ROLE) {
        require(!claimPaused, "claim has been already paused");

        claimPaused = true;

        emit PauseClaim();
    }

    /**
     * @notice Unpause claim. Can only be called by admin. 恢复领取功能
     */
    function unpauseClaim() public onlyRole(ADMIN_ROLE) {
        require(claimPaused, "claim has been already unpaused");

        claimPaused = false;

        emit UnpauseClaim();
    }

    /**
     * @notice Update staking start block. Can only be called by admin. 设置开始区块
     */
    function setStartBlock(uint256 _startBlock) public onlyRole(ADMIN_ROLE) {
        require(
            _startBlock <= endBlock,
            "start block must be smaller than end block"
        );

        startBlock = _startBlock;

        emit SetStartBlock(_startBlock);
    }

    /**
     * @notice Update staking end block. Can only be called by admin. 设置 结束区块
     */
    function setEndBlock(uint256 _endBlock) public onlyRole(ADMIN_ROLE) {
        require(
            startBlock <= _endBlock,
            "start block must be smaller than end block"
        );

        endBlock = _endBlock;

        emit SetEndBlock(_endBlock);
    }

    /**
     * @notice Update the MetaNode reward amount per block. Can only be called by admin. 设置每区块奖励数量
     */
    function setMetaNodePerBlock(
        uint256 _MetaNodePerBlock
    ) public onlyRole(ADMIN_ROLE) {
        require(_MetaNodePerBlock > 0, "invalid parameter");

        MetaNodePerBlock = _MetaNodePerBlock;

        emit SetMetaNodePerBlock(_MetaNodePerBlock);
    }

    /**
     * @notice Add a new staking to pool. Can only be called by admin  添加新的质押池
     * DO NOT add the same staking token more than once. MetaNode rewards will be messed up if you do
     */
    function addPool(
        address _stTokenAddress,
        uint256 _poolWeight,
        uint256 _minDepositAmount,
        uint256 _unstakeLockedBlocks,
        bool _withUpdate
    ) public onlyRole(ADMIN_ROLE) {
        // Default the first pool to be ETH pool, so the first pool must be added with stTokenAddress = address(0x0)
        // 第一个池必须是ETH池（地址为0）
        if (pool.length > 0) {
            require(
                _stTokenAddress != address(0x0),
                "invalid staking token address"
            );
        } else {
            require(
                _stTokenAddress == address(0x0),
                "invalid staking token address"
            );
        }
        // allow the min deposit amount equal to 0
        //require(_minDepositAmount > 0, "invalid min deposit amount");
        require(_unstakeLockedBlocks > 0, "invalid withdraw locked blocks");
        require(block.number < endBlock, "Already ended");

        // 如果需要，更新所有池的奖励
        if (_withUpdate) {
            massUpdatePools();
        }

        // 设置上次奖励区块
        uint256 lastRewardBlock = block.number > startBlock
            ? block.number
            : startBlock;
        totalPoolWeight = totalPoolWeight + _poolWeight;

        // 创建新池
        pool.push(
            Pool({
                stTokenAddress: _stTokenAddress,
                poolWeight: _poolWeight,
                lastRewardBlock: lastRewardBlock,
                accMetaNodePerST: 0,
                stTokenAmount: 0,
                minDepositAmount: _minDepositAmount,
                unstakeLockedBlocks: _unstakeLockedBlocks
            })
        );

        emit AddPool(
            _stTokenAddress,
            _poolWeight,
            lastRewardBlock,
            _minDepositAmount,
            _unstakeLockedBlocks
        );
    }

    /**  更新池信息
     * @notice Update the given pool's info (minDepositAmount and unstakeLockedBlocks). Can only be called by admin.
     */
    function updatePool(
        uint256 _pid,
        uint256 _minDepositAmount,
        uint256 _unstakeLockedBlocks
    ) public onlyRole(ADMIN_ROLE) checkPid(_pid) {
        pool[_pid].minDepositAmount = _minDepositAmount;
        pool[_pid].unstakeLockedBlocks = _unstakeLockedBlocks;

        emit UpdatePoolInfo(_pid, _minDepositAmount, _unstakeLockedBlocks);
    }

    /** 设置池权重
     * @notice Update the given pool's weight. Can only be called by admin.
     */
    function setPoolWeight(
        uint256 _pid,
        uint256 _poolWeight,
        bool _withUpdate
    ) public onlyRole(ADMIN_ROLE) checkPid(_pid) {
        require(_poolWeight > 0, "invalid pool weight");

        if (_withUpdate) {
            massUpdatePools();
        }
        // 更新总权重
        totalPoolWeight = totalPoolWeight - pool[_pid].poolWeight + _poolWeight;
        pool[_pid].poolWeight = _poolWeight;

        emit SetPoolWeight(_pid, _poolWeight, totalPoolWeight);
    }

    // ************************************** QUERY FUNCTION **************************************

    /** 获取池数量
     * @notice Get the length/amount of pool
     */
    function poolLength() external view returns (uint256) {
        return pool.length;
    }

    /** 计算区块区间的奖励倍数
     * @notice Return reward multiplier over given _from to _to block. [_from, _to)
     *
     * @param _from    From block number (included)
     * @param _to      To block number (exluded)
     * getMultiplier(pool_.lastRewardBlock, block.number).tryMul(pool_.poolWeight);
     */
    function getMultiplier(
        uint256 _from,
        uint256 _to
    ) public view returns (uint256 multiplier) {
        require(_from <= _to, "invalid block");
        // 如果结束时间在开始时间之前，返回0
        if (_to <= startBlock || _from >= endBlock) {
            return 0;
        }
        if (_from < startBlock) {
            _from = startBlock;
        }
        if (_to > endBlock) {
            _to = endBlock;
        }
        require(_from <= _to, "end block must be greater than start block");
        bool success;
        // 计算奖励倍数 = (结束区块 - 开始区块) * 每区块奖励
        (success, multiplier) = (_to - _from).tryMul(MetaNodePerBlock);
        require(success, "multiplier overflow");
    }

    /**
     * @notice Get pending MetaNode amount of user in pool  获取用户待领取的MetaNode数量
     */
    function pendingMetaNode(
        uint256 _pid,
        address _user
    ) external view checkPid(_pid) returns (uint256) {
        return pendingMetaNodeByBlockNumber(_pid, _user, block.number);
    }

    /**
     * @notice Get pending MetaNode amount of user by block number in pool 按区块号获取用户待领取的MetaNode数量
     */
    function pendingMetaNodeByBlockNumber(
        uint256 _pid,
        address _user,
        uint256 _blockNumber
    ) public view checkPid(_pid) returns (uint256) {
        Pool storage pool_ = pool[_pid];
        User storage user_ = user[_pid][_user];
        uint256 accMetaNodePerST = pool_.accMetaNodePerST;
        uint256 stSupply = pool_.stTokenAmount;

        // 如果当前区块大于上次奖励区块且有质押量，计算新增奖励
        if (_blockNumber > pool_.lastRewardBlock && stSupply != 0) {
            uint256 multiplier = getMultiplier(
                pool_.lastRewardBlock,
                _blockNumber
            );

            // 计算该池应得的奖励 = 总奖励 * 池权重 / 总权重
            uint256 MetaNodeForPool = (multiplier * pool_.poolWeight) /
                totalPoolWeight;
            // 更新每质押代币累计奖励
            accMetaNodePerST =
                accMetaNodePerST +
                (MetaNodeForPool * (1 ether)) /
                stSupply;
        }
        // 计算待领取奖励公式：
        // (用户质押量 * 每质押代币累计奖励) / 1e18 - 已领取奖励 + 待处理奖励
        return
            (user_.stAmount * accMetaNodePerST) /
            (1 ether) -
            user_.finishedMetaNode +
            user_.pendingMetaNode;
    }

    /**
     * @notice Get the staking amount of user 获取用户质押余额
     */
    function stakingBalance(
        uint256 _pid,
        address _user
    ) external view checkPid(_pid) returns (uint256) {
        return user[_pid][_user].stAmount;
    }

    /** 获取用户的提现金额信息
     * @notice Get the withdraw amount info, including the locked unstake amount and the unlocked unstake amount
     */
    function withdrawAmount(
        uint256 _pid,
        address _user
    )
        public
        view
        checkPid(_pid)
        returns (uint256 requestAmount, uint256 pendingWithdrawAmount)
    {
        User storage user_ = user[_pid][_user];
        // 遍历解质押请求
        for (uint256 i = 0; i < user_.requests.length; i++) {
            // 统计已解锁可提现金额
            if (user_.requests[i].unlockBlocks <= block.number) {
                pendingWithdrawAmount =
                    pendingWithdrawAmount +
                    user_.requests[i].amount;
            }
            // 统计总请求金额
            requestAmount = requestAmount + user_.requests[i].amount;
        }
    }

    // ************************************** PUBLIC FUNCTION 公共函数**************************************

    /**
     * @notice Update reward variables of the given pool to be up-to-date. 更新指定池的奖励变量到最新状态
     */
    function updatePool(uint256 _pid) public checkPid(_pid) {
        Pool storage pool_ = pool[_pid];
        // 如果当前区块不大于上次奖励区块，不需要更新
        if (block.number <= pool_.lastRewardBlock) {
            return;
        }
        // 计算该池应得的奖励
        (bool success1, uint256 totalMetaNode) = getMultiplier(
            pool_.lastRewardBlock,
            block.number
        ).tryMul(pool_.poolWeight);
        require(success1, "overflow");

        (success1, totalMetaNode) = totalMetaNode.tryDiv(totalPoolWeight);
        require(success1, "overflow");

        uint256 stSupply = pool_.stTokenAmount;
        if (stSupply > 0) {
            // 计算每质押代币新增奖励
            (bool success2, uint256 totalMetaNode_) = totalMetaNode.tryMul(
                1 ether
            );
            require(success2, "overflow");

            (success2, totalMetaNode_) = totalMetaNode_.tryDiv(stSupply);
            require(success2, "overflow");

            // 更新累计奖励
            (bool success3, uint256 accMetaNodePerST) = pool_
                .accMetaNodePerST
                .tryAdd(totalMetaNode_);
            require(success3, "overflow");
            pool_.accMetaNodePerST = accMetaNodePerST;
        }
        // 更新最后奖励区块
        pool_.lastRewardBlock = block.number;

        emit UpdatePool(_pid, pool_.lastRewardBlock, totalMetaNode);
    }

    /** 更新所有池的奖励变量
     * @notice Update reward variables for all pools. Be careful of gas spending!
     */
    function massUpdatePools() public {
        uint256 length = pool.length;
        for (uint256 pid = 0; pid < length; pid++) {
            updatePool(pid);
        }
    }

    /** 质押ETH（只支持池0）存入 ETH进行质押，获取MetaNode奖励
     * @notice Deposit staking ETH for MetaNode rewards
     */
    function depositETH() public payable whenNotPaused {
        Pool storage pool_ = pool[ETH_PID];
        require(
            pool_.stTokenAddress == address(0x0),
            "invalid staking token address"
        );

        uint256 _amount = msg.value;
        require(
            _amount >= pool_.minDepositAmount,
            "deposit amount is too small"
        );

        _deposit(ETH_PID, _amount);
    }

    /** 质押ERC20代币
     * @notice Deposit staking token for MetaNode rewards
     * Before depositing, user needs approve this contract to be able to spend or transfer their staking tokens
     *
     * @param _pid       Id of the pool to be deposited to
     * @param _amount    Amount of staking tokens to be deposited
     */
    function deposit(
        uint256 _pid,
        uint256 _amount
    ) public whenNotPaused checkPid(_pid) {
        require(_pid != 0, "deposit not support ETH staking");
        Pool storage pool_ = pool[_pid];
        require(
            _amount > pool_.minDepositAmount,
            "deposit amount is too small"
        );
        // 转移代币到合约
        if (_amount > 0) {
            IERC20(pool_.stTokenAddress).safeTransferFrom(
                msg.sender,
                address(this),
                _amount
            );
        }

        _deposit(_pid, _amount);
    }

    /** 请求解质押
     * @notice Unstake staking tokens
     *
     * @param _pid       Id of the pool to be withdrawn from
     * @param _amount    amount of staking tokens to be withdrawn
     */
    function unstake(
        uint256 _pid,
        uint256 _amount
    ) public whenNotPaused checkPid(_pid) whenNotWithdrawPaused {
        Pool storage pool_ = pool[_pid];
        User storage user_ = user[_pid][msg.sender];

        require(user_.stAmount >= _amount, "Not enough staking token balance");

        // 更新奖励
        updatePool(_pid);

        // 计算待领取奖励
        uint256 pendingMetaNode_ = (user_.stAmount * pool_.accMetaNodePerST) /
            (1 ether) -
            user_.finishedMetaNode;

        // 保存到待领取
        if (pendingMetaNode_ > 0) {
            user_.pendingMetaNode = user_.pendingMetaNode + pendingMetaNode_;
        }

        if (_amount > 0) {
            // 减少用户质押量
            user_.stAmount = user_.stAmount - _amount;
            // 创建解质押请求（锁定状态）
            user_.requests.push(
                UnstakeRequest({
                    amount: _amount,
                    unlockBlocks: block.number + pool_.unstakeLockedBlocks
                })
            );
        }

        // 更新池总质押量
        pool_.stTokenAmount = pool_.stTokenAmount - _amount;
        // 更新用户已领取奖励
        user_.finishedMetaNode =
            (user_.stAmount * pool_.accMetaNodePerST) /
            (1 ether);

        emit RequestUnstake(msg.sender, _pid, _amount);
    }

    /**
     * @notice Withdraw the unlock unstake amount 提现已解锁的代币
     *
     * @param _pid       Id of the pool to be withdrawn from
     */
    function withdraw(
        uint256 _pid
    ) public whenNotPaused checkPid(_pid) whenNotWithdrawPaused {
        Pool storage pool_ = pool[_pid];
        User storage user_ = user[_pid][msg.sender];

        uint256 pendingWithdraw_;
        uint256 popNum_;

        // 遍历解质押请求，找出已解锁的
        for (uint256 i = 0; i < user_.requests.length; i++) {
            if (user_.requests[i].unlockBlocks > block.number) {
                break;
            }
            pendingWithdraw_ = pendingWithdraw_ + user_.requests[i].amount;
            popNum_++;
        }

        // 移除已处理的请求（通过数组前移）
        for (uint256 i = 0; i < user_.requests.length - popNum_; i++) {
            user_.requests[i] = user_.requests[i + popNum_];
        }
        // 弹出已处理的元素
        for (uint256 i = 0; i < popNum_; i++) {
            user_.requests.pop();
        }
        // 转移代币给用户
        if (pendingWithdraw_ > 0) {
            if (pool_.stTokenAddress == address(0x0)) {
                _safeETHTransfer(msg.sender, pendingWithdraw_);
            } else {
                IERC20(pool_.stTokenAddress).safeTransfer(
                    msg.sender,
                    pendingWithdraw_
                );
            }
        }

        emit Withdraw(msg.sender, _pid, pendingWithdraw_, block.number);
    }

    /**
     * @notice Claim MetaNode tokens reward 领取奖励
     *
     * @param _pid       Id of the pool to be claimed from
     */
    function claim(
        uint256 _pid
    ) public whenNotPaused checkPid(_pid) whenNotClaimPaused {
        Pool storage pool_ = pool[_pid];
        User storage user_ = user[_pid][msg.sender];

        updatePool(_pid);
        // 计算总待领取奖励 = 当前计算奖励 + 之前保存的待领取
        uint256 pendingMetaNode_ = (user_.stAmount * pool_.accMetaNodePerST) /
            (1 ether) -
            user_.finishedMetaNode +
            user_.pendingMetaNode;

        if (pendingMetaNode_ > 0) {
            user_.pendingMetaNode = 0; // 清空待领取
            _safeMetaNodeTransfer(msg.sender, pendingMetaNode_); // 转移奖励
        }
        // 更新已领取奖励
        user_.finishedMetaNode =
            (user_.stAmount * pool_.accMetaNodePerST) /
            (1 ether);

        emit Claim(msg.sender, _pid, pendingMetaNode_);
    }

    // ************************************** INTERNAL FUNCTION  内部函数**************************************

    /** 内部质押函数
     * @notice Deposit staking token for MetaNode rewards
     *
     * @param _pid       Id of the pool to be deposited to
     * @param _amount    Amount of staking tokens to be deposited
     */
    function _deposit(uint256 _pid, uint256 _amount) internal {
        Pool storage pool_ = pool[_pid];
        User storage user_ = user[_pid][msg.sender];

        updatePool(_pid);

        // 如果用户已有质押，计算待领取奖励
        if (user_.stAmount > 0) {
            // uint256 accST = user_.stAmount.mulDiv(pool_.accMetaNodePerST, 1 ether);
            (bool success1, uint256 accST) = user_.stAmount.tryMul(
                pool_.accMetaNodePerST
            );
            require(success1, "user stAmount mul accMetaNodePerST overflow");
            (success1, accST) = accST.tryDiv(1 ether);
            require(success1, "accST div 1 ether overflow");

            (bool success2, uint256 pendingMetaNode_) = accST.trySub(
                user_.finishedMetaNode
            );
            require(success2, "accST sub finishedMetaNode overflow");

            if (pendingMetaNode_ > 0) {
                (bool success3, uint256 _pendingMetaNode) = user_
                    .pendingMetaNode
                    .tryAdd(pendingMetaNode_);
                require(success3, "user pendingMetaNode overflow");
                user_.pendingMetaNode = _pendingMetaNode;
            }
        }
        // 增加用户质押量
        if (_amount > 0) {
            (bool success4, uint256 stAmount) = user_.stAmount.tryAdd(_amount);
            require(success4, "user stAmount overflow");
            user_.stAmount = stAmount;
        }
        // 增加池总质押量
        (bool success5, uint256 stTokenAmount) = pool_.stTokenAmount.tryAdd(
            _amount
        );
        require(success5, "pool stTokenAmount overflow");
        pool_.stTokenAmount = stTokenAmount;

        // 更新用户已领取奖励
        // user_.finishedMetaNode = user_.stAmount.mulDiv(pool_.accMetaNodePerST, 1 ether);
        (bool success6, uint256 finishedMetaNode) = user_.stAmount.tryMul(
            pool_.accMetaNodePerST
        );
        require(success6, "user stAmount mul accMetaNodePerST overflow");

        (success6, finishedMetaNode) = finishedMetaNode.tryDiv(1 ether);
        require(success6, "finishedMetaNode div 1 ether overflow");

        user_.finishedMetaNode = finishedMetaNode;

        emit Deposit(msg.sender, _pid, _amount);
    }

    /** 安全转移MetaNode奖励
     * @notice Safe MetaNode transfer function, just in case if rounding error causes pool to not have enough MetaNodes
     *
     * @param _to        Address to get transferred MetaNodes
     * @param _amount    Amount of MetaNode to be transferred
     */
    function _safeMetaNodeTransfer(address _to, uint256 _amount) internal {
        uint256 MetaNodeBal = MetaNode.balanceOf(address(this));
        // 如果合约余额不足，只转余额
        if (_amount > MetaNodeBal) {
            MetaNode.transfer(_to, MetaNodeBal);
        } else {
            MetaNode.transfer(_to, _amount);
        }
    }

    /** 安全转移ETH
     * @notice Safe ETH transfer function
     *
     * @param _to        Address to get transferred ETH
     * @param _amount    Amount of ETH to be transferred
     */
    function _safeETHTransfer(address _to, uint256 _amount) internal {
        (bool success, bytes memory data) = address(_to).call{value: _amount}(
            ""
        );

        require(success, "ETH transfer call failed");
        if (data.length > 0) {
            require(
                abi.decode(data, (bool)),
                "ETH transfer operation did not succeed"
            );
        }
    }
}
