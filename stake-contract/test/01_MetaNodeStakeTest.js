const { ethers, upgrades } = require("hardhat")
const { expect } = require("chai")
const { time } = require("@nomicfoundation/hardhat-network-helpers")

describe("== MetaNodeStake 完整测试 ==", async function () {
    let admin, user1, user2, user3, attacker
    let erc20Contract, stakeProxyContract, erc20Contract2
    
    const metaNodePerBlock = ethers.parseEther("100")  // 100个MetaNode代币
    // const metaNodePerBlock = 100n
    const blockHeight = 10000
    const provider = ethers.provider
    const unstakeLockedBlocks = 10
    const minDepositAmount = ethers.parseEther("0.1")
    const zeroAddress = "0x0000000000000000000000000000000000000000"
    
    // 部署前的准备
    before(async function () {
        [admin, user1, user2, user3, attacker] = await ethers.getSigners()
    })

    // 部署测试
    describe("1、部署和初始化测试", function () {
        it("应该成功部署ERC20代币合约", async function () {
            const erc20 = await ethers.getContractFactory("MetaNodeToken")
            erc20Contract = await erc20.connect(admin).deploy()
            await erc20Contract.waitForDeployment()
            const erc20Address = await erc20Contract.getAddress()
            console.log("ERC20合约地址:", erc20Address)
            expect(erc20Address).to.have.lengthOf(42)
            
            // 测试代币基本信息
            const name = await erc20Contract.name()
            const symbol = await erc20Contract.symbol()
            expect(name).to.exist
            expect(symbol).to.exist
        })

        it("应该成功部署MetaNodeStake合约（UUPS代理模式）", async function () {
            const blockNumber = await provider.getBlockNumber()
            console.log("部署时区块高度:", blockNumber)
            
            const erc20Address = await erc20Contract.getAddress()
            const metaNodeStake = await ethers.getContractFactory("MetaNodeStake")
            
            stakeProxyContract = await upgrades.deployProxy(
                metaNodeStake.connect(admin), 
                [erc20Address, blockNumber, blockNumber + blockHeight, metaNodePerBlock], 
                { kind: "uups" }
            )
            
            await stakeProxyContract.waitForDeployment()
            const metaNodeStakeAddress = await stakeProxyContract.getAddress()
            console.log("质押合约地址:", metaNodeStakeAddress)
            expect(metaNodeStakeAddress).to.have.lengthOf(42)
            
            // 验证初始化参数
            const startBlock = await stakeProxyContract.startBlock()
            const endBlock = await stakeProxyContract.endBlock()
            const actualMetaNodePerBlock = await stakeProxyContract.MetaNodePerBlock()
            const metaNodeToken = await stakeProxyContract.MetaNode()
            
            expect(startBlock).to.equal(blockNumber)
            expect(endBlock).to.equal(blockNumber + blockHeight)
            expect(actualMetaNodePerBlock).to.equal(metaNodePerBlock)
            expect(metaNodeToken).to.equal(erc20Address)
        })

        it("应该成功添加ETH质押池（池0）", async function () {
            const minDepositAmount = ethers.parseEther("0.001")
            
            await stakeProxyContract.connect(admin).addPool(
                zeroAddress, 
                5, 
                minDepositAmount, 
                unstakeLockedBlocks, 
                false
            )
            
            const poolLength = await stakeProxyContract.poolLength()
            expect(poolLength).to.equal(1)
            
            const pool = await stakeProxyContract.pool(0)
            expect(pool.stTokenAddress).to.equal(zeroAddress)
            expect(pool.poolWeight).to.equal(5)
            expect(pool.minDepositAmount).to.equal(minDepositAmount)
            expect(pool.unstakeLockedBlocks).to.equal(unstakeLockedBlocks)
        })

        it("初始化后应该设置正确的角色权限", async function () {
            const adminRole = await stakeProxyContract.ADMIN_ROLE()
            const upgradeRole = await stakeProxyContract.UPGRADE_ROLE()
            const defaultAdminRole = await stakeProxyContract.DEFAULT_ADMIN_ROLE()
            
            // 验证管理员地址有正确的角色
            expect(await stakeProxyContract.hasRole(adminRole, admin.address)).to.be.true
            expect(await stakeProxyContract.hasRole(upgradeRole, admin.address)).to.be.true
            expect(await stakeProxyContract.hasRole(defaultAdminRole, admin.address)).to.be.true
            
            // 验证普通用户没有角色
            expect(await stakeProxyContract.hasRole(adminRole, user1.address)).to.be.false
            expect(await stakeProxyContract.hasRole(upgradeRole, user1.address)).to.be.false
        })

        it("应该拒绝无效的初始化参数", async function () {
            const erc20Address = await erc20Contract.getAddress()
            const metaNodeStake = await ethers.getContractFactory("MetaNodeStake")
            const blockNumber = await provider.getBlockNumber()
            //   console.log("blockNumber:", blockNumber)
            // 测试结束区块小于开始区块
            await expect(
                upgrades.deployProxy(
                    metaNodeStake.connect(admin),
                    [erc20Address, blockNumber, blockNumber - 1, metaNodePerBlock],
                    { kind: "uups" }
                )
            ).to.be.revertedWith("invalid parameters")
            
            // 测试每区块奖励为0
            await expect(
                upgrades.deployProxy(
                    metaNodeStake.connect(admin),
                    [erc20Address, blockNumber, blockNumber + 100, 0],
                    { kind: "uups" }
                )
            ).to.be.revertedWith("invalid parameters")

            const metaNodeStake2 = await ethers.getContractFactory("MetaNodeStake")
            const proxy = await upgrades.deployProxy(
                metaNodeStake2.connect(admin),
                [erc20Address, blockNumber + 1000, blockNumber + 2000, metaNodePerBlock],
                { kind: "uups" }
            )
            await proxy.waitForDeployment()
            
            // 尝试重复初始化
            await expect(
                proxy.connect(admin).initialize(
                    erc20Address,
                    blockNumber + 1000,
                    blockNumber + 2000,
                    metaNodePerBlock
                )
            ).to.be.revertedWithCustomError(proxy, "InvalidInitialization")
        })
    })

    // 管理员功能测试
    describe("2、管理员功能测试", function () {
        it("应该允许管理员设置新的MetaNode代币", async function () {
            // 部署第二个ERC20代币
            const erc20 = await ethers.getContractFactory("MetaNodeToken")
            erc20Contract2 = await erc20.connect(admin).deploy()
            await erc20Contract2.waitForDeployment()
            const newERC20Address = await erc20Contract2.getAddress()
            
            await stakeProxyContract.connect(admin).setMetaNode(newERC20Address)
            const updatedToken = await stakeProxyContract.MetaNode()
            expect(updatedToken).to.equal(newERC20Address)
        })

        it("应该拒绝非管理员设置MetaNode代币", async function () {
            const newERC20Address = await erc20Contract2.getAddress()
            await expect(
                stakeProxyContract.connect(user1).setMetaNode(newERC20Address)
            ).to.be.revertedWithCustomError(stakeProxyContract, "AccessControlUnauthorizedAccount")
        })

        it("应该允许管理员暂停和恢复提现", async function () {
            // 暂停提现
            await stakeProxyContract.connect(admin).pauseWithdraw()
            let isPaused = await stakeProxyContract.withdrawPaused()
            expect(isPaused).to.be.true
            
            // 重复暂停应该失败
            await expect(
                stakeProxyContract.connect(admin).pauseWithdraw()
            ).to.be.revertedWith("withdraw has been already paused")
            
            // 恢复提现
            await stakeProxyContract.connect(admin).unpauseWithdraw()
            isPaused = await stakeProxyContract.withdrawPaused()
            expect(isPaused).to.be.false
            
            // 重复恢复应该失败
            await expect(
                stakeProxyContract.connect(admin).unpauseWithdraw()
            ).to.be.revertedWith("withdraw has been already unpaused")
        })

        it("应该允许管理员暂停和恢复领取", async function () {
            // 暂停领取
            await stakeProxyContract.connect(admin).pauseClaim()
            let isPaused = await stakeProxyContract.claimPaused()
            expect(isPaused).to.be.true
            
            // 恢复领取
            await stakeProxyContract.connect(admin).unpauseClaim()
            isPaused = await stakeProxyContract.claimPaused()
            expect(isPaused).to.be.false
        })

        it("应该允许管理员更新开始和结束区块", async function () {
            const currentBlock = await provider.getBlockNumber()
            const newStartBlock = currentBlock + 100
            const newEndBlock = currentBlock + 200
            
            // 更新开始区块
            await stakeProxyContract.connect(admin).setStartBlock(newStartBlock)
            const startBlock = await stakeProxyContract.startBlock()
            expect(startBlock).to.equal(newStartBlock)
            
            // 更新结束区块
            await stakeProxyContract.connect(admin).setEndBlock(newEndBlock)
            const endBlock = await stakeProxyContract.endBlock()
            expect(endBlock).to.equal(newEndBlock)
            
            // 测试无效参数：开始区块大于结束区块
            await expect(
                stakeProxyContract.connect(admin).setStartBlock(newEndBlock + 1)
            ).to.be.revertedWith("start block must be smaller than end block")
            
            await expect(
                stakeProxyContract.connect(admin).setEndBlock(newStartBlock - 1)
            ).to.be.revertedWith("start block must be smaller than end block")
        })

        it("应该允许管理员更新每区块奖励", async function () {
            const newMetaNodePerBlock = ethers.parseEther("200")
            await stakeProxyContract.connect(admin).setMetaNodePerBlock(newMetaNodePerBlock)
            const actualValue = await stakeProxyContract.MetaNodePerBlock()
            expect(actualValue).to.equal(newMetaNodePerBlock)
            
            // 测试无效参数：奖励为0
            await expect(
                stakeProxyContract.connect(admin).setMetaNodePerBlock(0)
            ).to.be.revertedWith("invalid parameter")
            // 还原奖励：
            await stakeProxyContract.connect(admin).setMetaNodePerBlock(metaNodePerBlock)
        })

        it("应该允许管理员添加新的质押池", async function () {
            const erc20Address = await erc20Contract.getAddress()
            const poolWeight = 10
            const minDepositAmount = ethers.parseEther("0.1")
            
            await stakeProxyContract.connect(admin).addPool(
                erc20Address,
                poolWeight,
                minDepositAmount,
                unstakeLockedBlocks,
                false
            )
            
            const poolLength = await stakeProxyContract.poolLength()
            expect(poolLength).to.equal(2) // 添加2个池了
            
            const pool = await stakeProxyContract.pool(1)
            expect(pool.stTokenAddress).to.equal(erc20Address)
            expect(pool.poolWeight).to.equal(poolWeight)
            expect(pool.minDepositAmount).to.equal(minDepositAmount)
            expect(pool.unstakeLockedBlocks).to.equal(unstakeLockedBlocks)
            
            // 验证总权重更新
            const totalPoolWeight = await stakeProxyContract.totalPoolWeight()
            expect(totalPoolWeight).to.equal(15) // 第一个是5，这里10：  5 + 10
        })

        it("应该拒绝添加无效的质押池", async function () {
            const erc20Address = await erc20Contract.getAddress()
            
            // 测试添加第二个ETH池（地址为0）  因为前面的测试 已经添加一个ETH池了
            await expect(
                stakeProxyContract.connect(admin).addPool(
                    zeroAddress, 
                    5,
                    ethers.parseEther("0.001"),
                    unstakeLockedBlocks,
                    false
                )
            ).to.be.revertedWith("invalid staking token address")
            
            // 测试锁定期为0
            await expect(
                stakeProxyContract.connect(admin).addPool(
                    erc20Address,
                    5,
                    ethers.parseEther("1"),
                    0,   // 无效
                    false
                )
            ).to.be.revertedWith("invalid withdraw locked blocks")
            
            // 测试3：在结束后添加池
            
        })

        it("应该在结束后拒绝添加质押池", async function () {
            const erc20Address = await erc20Contract.getAddress()
            
            // 首先确保质押已经开始
            const startBlock = await stakeProxyContract.startBlock()
            let currentBlock = await provider.getBlockNumber()
            
            if (currentBlock < startBlock) {
                const blocksToMine = Number(startBlock )- Number(currentBlock)
                for (let i = 0; i < blocksToMine; i++) {
                    await provider.send("evm_mine", [])
                }
                currentBlock = await provider.getBlockNumber()
            }
            
            // 设置一个很近的结束区块（当前区块+5）
            const nearEndBlock = currentBlock + 5
            await stakeProxyContract.connect(admin).setEndBlock(nearEndBlock)
            
            console.log(`开始区块: ${startBlock}, 当前区块: ${currentBlock}, 结束区块: ${nearEndBlock}`)
            
            // 挖矿到结束区块之后
            const blocksToMine = nearEndBlock - currentBlock + 1
            for (let i = 0; i < blocksToMine; i++) {
                await provider.send("evm_mine", [])
            }
            
            // 验证当前区块超过结束区块
            const finalBlock = await provider.getBlockNumber()
            expect(finalBlock).to.be.gt(nearEndBlock)

            // 尝试添加池，应该失败
            await expect(
                stakeProxyContract.connect(admin).addPool(
                    erc20Address,
                    5,
                    ethers.parseEther("0.1"),
                    unstakeLockedBlocks,
                    false
                )
            ).to.be.revertedWith("Already ended")
           
            // 重新设置结束区块
            await stakeProxyContract.connect(admin).setEndBlock(nearEndBlock + 10000)
        })

        it("应该允许管理员更新池信息", async function () {
            const newMinDeposit = ethers.parseEther("0.02")
            const newLockedBlocks = 20
            
            await stakeProxyContract.connect(admin).updatePool(
                1,
                newMinDeposit,
                newLockedBlocks
            )
            
            const pool = await stakeProxyContract.pool(1)
            expect(pool.minDepositAmount).to.equal(newMinDeposit)
            expect(pool.unstakeLockedBlocks).to.equal(newLockedBlocks)

            // 还原：
             await stakeProxyContract.connect(admin).updatePool(
                1,
                minDepositAmount,
                unstakeLockedBlocks
            )
        })

        it("应该允许管理员更新池权重", async function () {
            const newPoolWeight = 20
            
            await stakeProxyContract.connect(admin).setPoolWeight(
                1,
                newPoolWeight,
                true  // 更新所有池
            )
            
            const pool = await stakeProxyContract.pool(1)
            expect(pool.poolWeight).to.equal(newPoolWeight)
            
            const totalPoolWeight = await stakeProxyContract.totalPoolWeight()
            expect(totalPoolWeight).to.equal(25) // 5 + 20
        })

        it("应该拒绝无效的池权重", async function () {
            await expect(
                stakeProxyContract.connect(admin).setPoolWeight(1, 0, false)
            ).to.be.revertedWith("invalid pool weight")
        })
    })

    // 查询功能测试
    describe("3、查询功能测试", function () {
        it("应该正确计算奖励乘数", async function () {
            const startBlock = await stakeProxyContract.startBlock()
            const fromBlock = startBlock + 10n
            const toBlock = startBlock + 20n
            
            const multiplier = await stakeProxyContract.getMultiplier(fromBlock, toBlock) / ethers.parseEther("1")
            const expectedMultiplier = metaNodePerBlock * (toBlock - fromBlock) / ethers.parseEther("1")
            
            expect(multiplier).to.equal(expectedMultiplier)
            
            // 测试边界情况：from大于to
            await expect(
                stakeProxyContract.getMultiplier(toBlock, fromBlock)
            ).to.be.revertedWith("invalid block")
            
            // 测试区块范围超出奖励区间
            const beforeStart = startBlock - 10n
            const afterEnd = (await stakeProxyContract.endBlock()) + 10n
            
            const multiplier2 = await stakeProxyContract.getMultiplier(beforeStart, afterEnd) / ethers.parseEther("1")
            const effectiveFrom = beforeStart < startBlock ? startBlock : beforeStart
            const effectiveTo = afterEnd > (await stakeProxyContract.endBlock()) ? (await stakeProxyContract.endBlock()) : afterEnd
            const expectedMultiplier2 = metaNodePerBlock * (effectiveTo - effectiveFrom) / ethers.parseEther("1")

            expect(multiplier2).to.equal(expectedMultiplier2)
        })

        it("应该正确计算待领取奖励", async function () {
            // 先进行一些质押
            const depositAmount = ethers.parseEther("10") // todo pending奖励和质押量无关?
            await stakeProxyContract.connect(user1).depositETH({ value: depositAmount })

            // 前进10个区块
            for (let i = 0; i < 20; i++) {
                await provider.send("evm_mine", [])
            }
           
            // 奖励 = (结束区块 - 开始区块) * 每区块奖励： 20个区块 * 一个区块奖励 100 * 池0的权重5/池1的权重20（总的25） ，即100 * 20 * 5/25 = 400
            const pending = await stakeProxyContract.pendingMetaNode(0, user1.address)
            expect(pending).to.be.equal(ethers.parseEther("400"))
            
            // 测试通过指定区块号计算
            const currentBlock = await provider.getBlockNumber()
            const pendingByBlock = await stakeProxyContract.pendingMetaNodeByBlockNumber(
                0, 
                user1.address,
                Number(currentBlock) + Number(1) // 下一个区块的奖励
            )
       
            expect(pendingByBlock).to.be.gt(pending) // 未来区块应该奖励更多
        })

        it("应该正确查询质押余额", async function () {
            const depositAmount = ethers.parseEther("10")
            const balance = await stakeProxyContract.stakingBalance(0, user1.address)
            expect(balance).to.equal(depositAmount)
            
            // 测试无效池ID
            await expect(
                stakeProxyContract.stakingBalance(999, user1.address)
            ).to.be.revertedWith("invalid pid")
        })

        it("应该正确查询提现金额信息", async function () {
   
             // 记录解质押前的状态
            const beforeRequests = await stakeProxyContract.withdrawAmount(0, user1.address)
            console.log(`解质押前 - 总请求: ${beforeRequests[0].toString()}, 待提现: ${beforeRequests[1].toString()}`)

            // 先创建一个解质押请求
            const unStakeAmount = ethers.parseEther("3")
            await stakeProxyContract.connect(user1).unstake(0, unStakeAmount)
    
            const [requestAmount, pendingWithdrawAmount] = await stakeProxyContract.withdrawAmount(0, user1.address)
            expect(requestAmount).to.equal(unStakeAmount)
            expect(pendingWithdrawAmount).to.equal(0) // 还未解锁
   
            // 前进锁定区块数
            for (let i = 0; i < unstakeLockedBlocks; i++) {
                await provider.send("evm_mine", [])
            }
            
            const [requestAmount2, pendingWithdrawAmount2] = await stakeProxyContract.withdrawAmount(0, user1.address)
            expect(requestAmount2).to.equal(unStakeAmount)
            expect(pendingWithdrawAmount2).to.equal(unStakeAmount) // 已解锁
            let userStake = await stakeProxyContract.stakingBalance(0, user1.address)
            const afterRequests = await stakeProxyContract.withdrawAmount(0, user1.address)
            console.log(`第一次user1：解质押 3 后 - 总请求: ${afterRequests[0].toString()}, 待提现: ${afterRequests[1].toString()}, 总质押：${userStake}`)
        })
    })

    // 用户功能测试
    describe("4、用户质押功能测试", function () {
        beforeEach(async function () {
            // 确保合约有足够的MetaNode代币来支付奖励
            const metaNodeTokenAddress = await stakeProxyContract.MetaNode()
            const metaNodeToken = await ethers.getContractAt("MetaNodeToken", metaNodeTokenAddress)
            const contractAddress = await stakeProxyContract.getAddress()
            
            // 给合约转一些MetaNode代币作为奖励
            await metaNodeToken.connect(admin).transfer(contractAddress, ethers.parseEther("1000000"))
        })

        it("应该允许用户质押ETH", async function () {
            const user1BalanceBefore = await provider.getBalance(user1.address)
            const contractAddress = await stakeProxyContract.getAddress()
            const contractBalanceBefore = await provider.getBalance(contractAddress)
            
            const depositAmount = ethers.parseEther("5")
            const tx = await stakeProxyContract.connect(user1).depositETH({ value: depositAmount })
            const receipt = await tx.wait()
            const gasUsed = receipt.gasUsed * receipt.gasPrice
            
            const user1BalanceAfter = await provider.getBalance(user1.address)
            const contractBalanceAfter = await provider.getBalance(contractAddress)
            
            expect(contractBalanceAfter - contractBalanceBefore).to.equal(depositAmount)
            // ETH余额检查需要包含gas费，这里只检查大概范围
            const balanceDiff = user1BalanceBefore - user1BalanceAfter
            expect(balanceDiff).to.be.gt(depositAmount)
            expect(balanceDiff).to.be.lt(depositAmount + gasUsed * 2n)
            
            // 验证质押记录
            const userStake = await stakeProxyContract.stakingBalance(0, user1.address)
            expect(userStake).to.equal(ethers.parseEther("12")) // 之前已经有10个，提取了3个，又加5个等于12
            
            const pool = await stakeProxyContract.pool(0)
            expect(pool.stTokenAmount).to.be.gt(0)
            
            const afterRequests = await stakeProxyContract.withdrawAmount(0, user1.address)
            console.log(`第二次user1：质押 5 后 - 总请求: ${afterRequests[0].toString()}, 待提现: ${afterRequests[1].toString()}, 总质押：${userStake}`)
        })

        it("应该拒绝低于最小金额的ETH质押", async function () {
            const pool0 = await stakeProxyContract.pool(0)
            const minDeposit = pool0.minDepositAmount
            const smallAmount = minDeposit - 1n
            
            await expect(
                stakeProxyContract.connect(user2).depositETH({ value: smallAmount })
            ).to.be.revertedWith("deposit amount is too small")
        })

        it("应该允许用户质押ERC20代币", async function () {
            const erc20Address = await erc20Contract.getAddress()
            const poolId = 1
            const depositAmount = ethers.parseEther("100")
            
            // 给用户转账并授权
            await erc20Contract.connect(admin).transfer(user2.address, depositAmount)
            await erc20Contract.connect(user2).approve(
                await stakeProxyContract.getAddress(),
                depositAmount
            )
            
            // 用户余额前
            const userBalanceBefore = await erc20Contract.balanceOf(user2.address)
            const contractAddress = await stakeProxyContract.getAddress()
            const contractBalanceBefore = await erc20Contract.balanceOf(contractAddress)
            
            // 质押
            await stakeProxyContract.connect(user2).deposit(poolId, depositAmount)
            
            // 用户余额后
            const userBalanceAfter = await erc20Contract.balanceOf(user2.address)
            const contractBalanceAfter = await erc20Contract.balanceOf(contractAddress)
            
            expect(userBalanceBefore - userBalanceAfter).to.equal(depositAmount)
            expect(contractBalanceAfter - contractBalanceBefore).to.equal(depositAmount)
            
            // 验证质押记录
            const userStake = await stakeProxyContract.stakingBalance(poolId, user2.address)
            expect(userStake).to.equal(depositAmount)
            
            const afterRequests = await stakeProxyContract.withdrawAmount(poolId, user2.address)
            console.log(`第1次user2：质押 100 后 - 总请求: ${afterRequests[0].toString()}, 待提现: ${afterRequests[1].toString()}, 总质押：${userStake}`)
        })

        it("应该拒绝在ETH池使用deposit函数", async function () {
            await expect(
                stakeProxyContract.connect(user1).deposit(0, ethers.parseEther("1"))
            ).to.be.revertedWith("deposit not support ETH staking")
        })

        it("应该拒绝低于最小金额的ERC20质押", async function () {
            const poolId = 1
            const poolInfo = await stakeProxyContract.pool(poolId)
            const minDeposit = poolInfo.minDepositAmount
            const smallAmount = minDeposit - 1n
            
            await erc20Contract.connect(admin).transfer(user3.address, smallAmount)
            await erc20Contract.connect(user3).approve(
                await stakeProxyContract.getAddress(),
                smallAmount
            )
            
            await expect(
                stakeProxyContract.connect(user3).deposit(poolId, smallAmount)
            ).to.be.revertedWith("deposit amount is too small")
        })

        it("质押时应该正确更新奖励", async function () {
            // 用户1已有ETH质押，用户2新质押
            const depositAmount = ethers.parseEther("10")
            await stakeProxyContract.connect(user2).depositETH({ value: depositAmount })
         
            // 前进锁定区块数
            for (let i = 0; i < unstakeLockedBlocks; i++) {
                await provider.send("evm_mine", [])
            }
            
            // 检查用户1的待领取奖励（应该比用户2多，因为质押时间更长）
            const pending1 = await stakeProxyContract.pendingMetaNode(0, user1.address)
            const pending2 = await stakeProxyContract.pendingMetaNode(0, user2.address)
            
            expect(pending1).to.be.gt(pending2)
            console.log(`用户1奖励: ${pending1}, 用户2奖励: ${pending2}`)
        })
    })

    describe("5、用户解质押功能测试", function () {
        it("应该允许用户解质押", async function () {
            const poolId = 0
            const unstakeAmount = ethers.parseEther("4")
            
            const userStakeBefore = await stakeProxyContract.stakingBalance(poolId, user1.address)
            const poolStakeBefore = (await stakeProxyContract.pool(poolId)).stTokenAmount
            
            await stakeProxyContract.connect(user1).unstake(poolId, unstakeAmount)
            
            const userStakeAfter = await stakeProxyContract.stakingBalance(poolId, user1.address)
            const poolStakeAfter = (await stakeProxyContract.pool(poolId)).stTokenAmount
            
            expect(userStakeBefore - userStakeAfter).to.equal(unstakeAmount)
            expect(poolStakeBefore - poolStakeAfter).to.equal(unstakeAmount)

            // 6. 验证可以查询到解质押请求（通过withdrawAmount）
            let userStake = await stakeProxyContract.stakingBalance(0, user1.address)
            const [totalRequests, pendingRequests] = await stakeProxyContract.withdrawAmount(poolId, user1.address)
            console.log(`第三次user1：解质押 4 后 - 总请求: ${totalRequests}, 待提现: ${pendingRequests}, 总质押：${userStake}`)

            expect(totalRequests).to.equal(unstakeAmount + ethers.parseEther("3")) // 前面 请求解压了3个
            expect(pendingRequests).to.equal(ethers.parseEther("3"))  // 还未解锁，所以还是原来的3个

        })

        it("应该拒绝超过质押余额的解质押", async function () {
            const userStake = await stakeProxyContract.stakingBalance(0, user1.address)
            const excessAmount = userStake + ethers.parseEther("1")
            
            await expect(
                stakeProxyContract.connect(user1).unstake(0, excessAmount)
            ).to.be.revertedWith("Not enough staking token balance")
        })

        it("解质押时应该正确计算待领取奖励", async function () {
            
            // 前进锁定区块数
            for (let i = 0; i < unstakeLockedBlocks; i++) {
                await provider.send("evm_mine", [])
            }
            
            const pendingBefore = await stakeProxyContract.pendingMetaNode(0, user1.address)
            const userInfoBefore = await stakeProxyContract.user(0, user1.address)
            
            await stakeProxyContract.connect(user1).unstake(0, ethers.parseEther("2"))
            
            const pendingAfter = await stakeProxyContract.pendingMetaNode(0, user1.address)
            const userInfoAfter = await stakeProxyContract.user(0, user1.address)

            let userStake = await stakeProxyContract.stakingBalance(0, user1.address)
            const [totalRequests, pendingRequests] = await stakeProxyContract.withdrawAmount(0, user1.address)
            console.log(`第四次user1：解质押 2 后 - 总请求: ${totalRequests}, 待提现: ${pendingRequests}, 总质押：${userStake}`)
        
            // 待领取奖励应该保存到pendingMetaNode中
            expect(userInfoAfter.pendingMetaNode).to.be.gt(userInfoBefore.pendingMetaNode)
        })

        it("应该拒绝在提现暂停时解质押", async function () {
            await stakeProxyContract.connect(admin).pauseWithdraw()
            
            await expect(
                stakeProxyContract.connect(user1).unstake(0, ethers.parseEther("1"))
            ).to.be.revertedWith("withdraw is paused")
            
            await stakeProxyContract.connect(admin).unpauseWithdraw()
        })
    })

    describe("6、用户提现功能测试", function () {
        it("应该允许用户提现已解锁的ETH", async function () {
            const poolId = 0
            
            // 等待锁定期结束（第一个请求应该已经解锁）
            // await time.increase(unstakeLockedBlocks)
            // 前进锁定区块数
            for (let i = 0; i < unstakeLockedBlocks; i++) {
                await provider.send("evm_mine", [])
            }
            
            const userBalanceBefore = await provider.getBalance(user1.address)
            const contractAddress = await stakeProxyContract.getAddress()
            const contractBalanceBefore = await provider.getBalance(contractAddress)
            const [totalRequests, pendingRequests] = await stakeProxyContract.withdrawAmount(poolId, user1.address)

            await stakeProxyContract.connect(user1).withdraw(poolId) // 提现
            
            const userBalanceAfter = await provider.getBalance(user1.address)
            const contractBalanceAfter = await provider.getBalance(contractAddress)
            
            // 检查余额变化（考虑gas费）
            expect(contractBalanceBefore - contractBalanceAfter).to.equal(pendingRequests)  // 提现所有 待提现的
            expect(userBalanceAfter - userBalanceBefore).to.lt(pendingRequests) // 去掉gas费，小于

            // 6. 验证可以查询到解质押请求（通过withdrawAmount）
            const [totalRequests1, pendingRequests1] = await stakeProxyContract.withdrawAmount(poolId, user1.address)
            let userStake = await stakeProxyContract.stakingBalance(0, user1.address)
            console.log(`第五次user1：提现后 - 总请求: ${totalRequests}, 待提现: ${pendingRequests}, 总质押：${userStake}`)

            expect(totalRequests1).to.equal(ethers.parseEther("0")) // 提现后归 0
            expect(pendingRequests1).to.equal(ethers.parseEther("0"))  // 

        })

        it("应该拒绝在提现暂停时提现", async function () {
            // 先创建一个解质押请求
            await stakeProxyContract.connect(user2).unstake(0, ethers.parseEther("1")) // user2第二次，之前质押10个，现在解质押1

            for (let i = 0; i < unstakeLockedBlocks; i++) {
                await provider.send("evm_mine", [])
            }
            
            await stakeProxyContract.connect(admin).pauseWithdraw()
            
            await expect(
                stakeProxyContract.connect(user2).withdraw(0)
            ).to.be.revertedWith("withdraw is paused")
            
            await stakeProxyContract.connect(admin).unpauseWithdraw()
        })

        it("提现ERC20池应该使用正确的转账方式", async function () {
            // 测试ERC20池提现
            const erc20PoolId = 1
            const erc20Amount = ethers.parseEther("50")
            
            // 用户2在ERC20池解质押
            await stakeProxyContract.connect(user2).unstake(erc20PoolId, erc20Amount)
            
            // 等待解锁
            // 前进锁定区块数
            for (let i = 0; i < unstakeLockedBlocks; i++) {
                await provider.send("evm_mine", [])
            }
            
            const userBalanceBefore = await erc20Contract.balanceOf(user2.address)
            
            await stakeProxyContract.connect(user2).withdraw(erc20PoolId)
            
            const userBalanceAfter = await erc20Contract.balanceOf(user2.address)
            console.log("提现ETH池和ERC20池:", userBalanceBefore, userBalanceAfter, erc20Amount)
            expect(userBalanceAfter - userBalanceBefore).to.equal(erc20Amount)
        })
    })

    describe("7、用户领取奖励功能测试", function () {
        it("应该允许用户领取奖励", async function () {
            const poolId = 0
            
            // 前进一些区块积累奖励
            for (let i = 0; i < unstakeLockedBlocks; i++) {
                await provider.send("evm_mine", [])
            }
            
            const pendingBefore = await stakeProxyContract.pendingMetaNode(poolId, user1.address)
            expect(pendingBefore).to.be.gt(0)
            
            const userBalanceBefore = await erc20Contract2.balanceOf(user1.address)
            
            await stakeProxyContract.connect(user1).claim(poolId)
            
            const pendingAfter = await stakeProxyContract.pendingMetaNode(poolId, user1.address)
            const userBalanceAfter = await erc20Contract2.balanceOf(user1.address)
            
            expect(pendingAfter).to.equal(0)
            expect(userBalanceAfter - userBalanceBefore).to.gt(pendingBefore)
        })

        it("领取应该包含pendingMetaNode中的奖励", async function () {
            const poolId = 0
            
            // 通过解质押将奖励保存到pendingMetaNode
            await stakeProxyContract.connect(user1).unstake(poolId, ethers.parseEther("1"))
            
            const userInfoBefore = await stakeProxyContract.user(poolId, user1.address)
            const pendingMetaNodeBefore = userInfoBefore.pendingMetaNode
            
            expect(pendingMetaNodeBefore).to.be.gt(0)
            
            // 领取奖励
            await stakeProxyContract.connect(user1).claim(poolId)
            
            const userInfoAfter = await stakeProxyContract.user(poolId, user1.address)
            const pendingMetaNodeAfter = userInfoAfter.pendingMetaNode
            
            expect(pendingMetaNodeAfter).to.equal(0)
        })

        it("应该拒绝在领取暂停时领取奖励", async function () {
            await stakeProxyContract.connect(admin).pauseClaim()
            
            await expect(
                stakeProxyContract.connect(user1).claim(0)
            ).to.be.revertedWith("claim is paused")
            
            await stakeProxyContract.connect(admin).unpauseClaim()
        })

        it("没有奖励时领取不应该失败", async function () {
            // 新用户没有奖励
            await stakeProxyContract.connect(attacker).claim(0)
            // 应该成功执行，只是没有转账
        })
    })

    describe("8、批量更新功能测试", function () {
        it("massUpdatePools应该更新所有池", async function () {
            // 获取所有池的最后奖励区块
            const pool0Before = (await stakeProxyContract.pool(0)).lastRewardBlock
            const pool1Before = (await stakeProxyContract.pool(1)).lastRewardBlock
            
            // 前进一些区块
            await time.increase(10)
            
            // 批量更新
            await stakeProxyContract.massUpdatePools()
            
            const pool0After = (await stakeProxyContract.pool(0)).lastRewardBlock
            const pool1After = (await stakeProxyContract.pool(1)).lastRewardBlock
            
            expect(pool0After).to.be.gt(pool0Before)
            expect(pool1After).to.be.gt(pool1Before)
        })

        it("单个updatePool应该只更新指定池", async function () {
            const pool0Before = (await stakeProxyContract.pool(0)).lastRewardBlock
            const pool1Before = (await stakeProxyContract.pool(1)).lastRewardBlock
            
            await time.increase(5)
            
            // 只更新池0
            await stakeProxyContract.updatePool(0)
            
            const pool0After = (await stakeProxyContract.pool(0)).lastRewardBlock
            const pool1After = (await stakeProxyContract.pool(1)).lastRewardBlock
            
            expect(pool0After).to.be.gt(pool0Before)
            expect(pool1After).to.equal(pool1Before) // 池1应该没变
        })
    })

    describe("9、边界条件和异常测试", function () {
        it("应该处理奖励计算中的溢出", async function () {
            // 设置一个巨大的每区块奖励
            const hugeReward = ethers.MaxUint256
            await stakeProxyContract.connect(admin).setMetaNodePerBlock(hugeReward)
            
            const startBlock = await stakeProxyContract.startBlock()
            const endBlock = await stakeProxyContract.endBlock()
            
            // 测试计算大数奖励
            await expect(
                stakeProxyContract.getMultiplier(startBlock, endBlock)
            ).to.be.revertedWith("multiplier overflow")
            
            // 恢复正常的奖励
            await stakeProxyContract.connect(admin).setMetaNodePerBlock(metaNodePerBlock)
        })

        it("应该处理空池的奖励更新", async function () {
            // 添加一个没有人质押的池
            const erc20Address = await erc20Contract.getAddress()
            await stakeProxyContract.connect(admin).addPool(
                erc20Address,
                5,
                ethers.parseEther("1"),
                unstakeLockedBlocks,
                false
            )
            
            const newPoolId = 2
            
            // 更新空池不应该失败
            await stakeProxyContract.updatePool(newPoolId)
            
            const pool = await stakeProxyContract.pool(newPoolId)
            expect(pool.lastRewardBlock).to.be.gt(0)
            expect(pool.accMetaNodePerST).to.equal(0)
        })

        it("应该处理合约MetaNode余额不足的情况", async function () {
            // 1. 确保测试环境
            // 检查用户是否有质押
            let userStake = await stakeProxyContract.stakingBalance(0, user1.address)
            if (userStake === 0n) {
                console.log("用户没有质押，先质押少量ETH")
                await stakeProxyContract.connect(user1).depositETH({ 
                    value: ethers.parseEther("0.5") 
                })
                userStake = await stakeProxyContract.stakingBalance(0, user1.address)
            }

            // 2. 积累一些奖励
            for (let i = 0; i < 5; i++) {
                await provider.send("evm_mine", [])
            }
            
            const pending = await stakeProxyContract.pendingMetaNode(0, user1.address)
            console.log(`待领取奖励: ${ethers.formatEther(pending)}`)
            
            if (pending === 0n) {
                console.log("警告：没有奖励可领取")
            }
            
            // 无论合约余额多少，claim都不应该回滚
            // 因为_safeMetaNodeTransfer会处理余额不足的情况
            await expect(
                stakeProxyContract.connect(user1).claim(0)
            ).to.not.be.reverted
            
            // 4. 可以多次调用，验证幂等性
            console.log("再次调用claim验证幂等性...")
            await expect(
                stakeProxyContract.connect(user1).claim(0)
            ).to.not.be.reverted
            
    

        })

        it("应该拒绝无效的池ID", async function () {
            const invalidPid = 999
            
            await expect(
                stakeProxyContract.deposit(invalidPid, ethers.parseEther("1"))
            ).to.be.revertedWith("invalid pid")
            
            await expect(
                stakeProxyContract.unstake(invalidPid, ethers.parseEther("1"))
            ).to.be.revertedWith("invalid pid")
            
            await expect(
                stakeProxyContract.withdraw(invalidPid)
            ).to.be.revertedWith("invalid pid")
            
            await expect(
                stakeProxyContract.claim(invalidPid)
            ).to.be.revertedWith("invalid pid")
        })

    })

    describe("10、完整业务流程测试", function () {
        it("完整的质押-领取-解质押-提现流程", async function () {
            const poolId = 0
            const depositAmount = ethers.parseEther("10")
            const unstakeAmount = ethers.parseEther("3")
            
            // 1. 质押
            await stakeProxyContract.connect(user3).depositETH({ value: depositAmount })
            
            // 2. 等待积累奖励, 前进区块数
            for (let i = 0; i < 4; i++) {
                await provider.send("evm_mine", [])
            }
            
            // 3. 领取奖励
            const pendingBeforeClaim = await stakeProxyContract.pendingMetaNode(poolId, user3.address)
            await stakeProxyContract.connect(user3).claim(poolId)
            
            // 4. 解质押部分代币
            await stakeProxyContract.connect(user3).unstake(poolId, unstakeAmount)
            
            // 5. 等待锁定期, 前进锁定区块数
            for (let i = 0; i < unstakeLockedBlocks; i++) {
                await provider.send("evm_mine", [])
            }
            
            // 6. 提现
            const balanceBefore = await provider.getBalance(user3.address)
            await stakeProxyContract.connect(user3).withdraw(poolId)
            const balanceAfter = await provider.getBalance(user3.address)
            
            // 验证最终状态
            const finalStake = await stakeProxyContract.stakingBalance(poolId, user3.address)
            const finalPending = await stakeProxyContract.pendingMetaNode(poolId, user3.address)
            
            const [totalRequests, pendingRequests] = await stakeProxyContract.withdrawAmount(poolId, user3.address)

            expect(finalStake).to.equal(depositAmount - unstakeAmount)
            expect(pendingRequests).to.equal(0)
            
            // ETH余额检查（考虑gas费）
            const ethGained = balanceAfter - balanceBefore

            expect(ethGained).to.be.gt(unstakeAmount - ethers.parseEther("0.1"))
            expect(ethGained).to.be.lt(unstakeAmount)
            
            console.log(`最终质押: ${ethers.formatEther(finalStake)} ETH`)
            console.log(`领取的奖励: ${ethers.formatEther(pendingBeforeClaim)} MetaNode`)
            console.log(`提现ETH: ${ethers.formatEther(ethGained)} ETH (扣除gas费)`)
        })
    })

    describe("11、升级功能测试", function () {
        it("应该允许有UPGRADE_ROLE的角色升级合约", async function () {
            // 部署新版本的合约逻辑
            const MetaNodeStakeV2 = await ethers.getContractFactory("MetaNodeStakeV2")
            
            // 升级合约
            const proxy = await upgrades.upgradeProxy(
                await stakeProxyContract.getAddress(),
                MetaNodeStakeV2,
                { kind: "uups" }
            )
            
            proxyAddress = await proxy.getAddress()
            console.log("合约升级成功,地址：", proxyAddress)
            // 验证升级成功 - 测试新功能
            await proxy.setNewVersionVariable(42);
            const newD = await proxy.newVersionVariable();
            // console.log("newVersionVariable: ", newD.toString())
            expect(newD).to.equal(42);


            // 测试新函数
            const version = await proxy.getVersion();
            // console.log("合约版本: ", version)
            expect(version).to.equal("V2.0");
            
            // 验证原有功能仍然正常工作
            const poolLength = await proxy.poolLength();
            // console.log("池数量仍然存在: ", poolLength.toString())
            expect(poolLength).to.be.gt(0);
            
        })

        it("应该拒绝没有UPGRADE_ROLE的角色升级合约", async function () {
            const MetaNodeStakeV2 = await ethers.getContractFactory("MetaNodeStakeV2")
            
            await expect(
                upgrades.upgradeProxy(
                    await stakeProxyContract.getAddress(),
                    MetaNodeStakeV2.connect(user1), // 使用用户账户
                    { kind: "uups" }
                )
            ).to.be.reverted
        })
    
        it("应该拒绝非管理员设置newVersionVariable", async function () {
            const MetaNodeStakeV2 = await ethers.getContractFactory("MetaNodeStakeV2")
            const proxy = await upgrades.upgradeProxy(
                await stakeProxyContract.getAddress(),
                MetaNodeStakeV2,
                { kind: "uups" }
            )
            
            // 普通用户应该不能调用管理员函数
            await expect(
                proxy.connect(user1).setNewVersionVariable(100)
            ).to.be.reverted
            
            // 管理员应该可以调用
            await proxy.connect(admin).setNewVersionVariable(100)
            const value = await proxy.newVersionVariable()
            expect(value).to.equal(100)
        })
        
        it("升级后原有用户数据和状态应该保持不变", async function () {
            const MetaNodeStakeV2 = await ethers.getContractFactory("MetaNodeStakeV2")
            const proxy = await upgrades.upgradeProxy(
                await stakeProxyContract.getAddress(),
                MetaNodeStakeV2,
                { kind: "uups" }
            )
            
            // 验证原有用户数据仍然存在
            const user1Stake = await proxy.stakingBalance(0, user1.address)
            console.log("升级后用户1质押余额: ", user1Stake.toString())
            expect(user1Stake).to.be.gt(0)
            
            // 验证合约基本参数仍然存在
            const startBlock = await proxy.startBlock()
            const endBlock = await proxy.endBlock()
            const metaNodePerBlock = await proxy.MetaNodePerBlock()
            
            console.log("升级后参数 - 开始区块: ", startBlock.toString())
            console.log("升级后参数 - 结束区块: ", endBlock.toString())
            console.log("升级后参数 - 每区块奖励: ", metaNodePerBlock.toString())
            
            expect(startBlock).to.be.gt(0)
            expect(endBlock).to.be.gt(startBlock)
            expect(metaNodePerBlock).to.equal(metaNodePerBlock) // 使用外部的metaNodePerBlock变量
        })
        
        it("升级后原有功能应该仍然正常工作", async function () {
            const MetaNodeStakeV2 = await ethers.getContractFactory("MetaNodeStakeV2")
            const proxy = await upgrades.upgradeProxy(
                await stakeProxyContract.getAddress(),
                MetaNodeStakeV2,
                { kind: "uups" }
            )
            
            // 测试原有功能：添加新池
            const erc20Address = await erc20Contract.getAddress()
            const poolWeight = 5
            const minDepositAmount = ethers.parseEther("0.5")
            
            await proxy.connect(admin).addPool(
                erc20Address,
                poolWeight,
                minDepositAmount,
                unstakeLockedBlocks,
                false
            )
            
            const poolLength = await proxy.poolLength()
            console.log("升级后添加新池，池数量: ", poolLength.toString())
            expect(poolLength).to.be.gt(2) // 原来有2个池，现在应该更多
            
            // 测试原有功能：用户质押
            const depositAmount = ethers.parseEther("1")
            await proxy.connect(user2).depositETH({ value: depositAmount })
            
            const userStake = await proxy.stakingBalance(0, user2.address)
            console.log("升级后用户2质押: ", userStake.toString())
            expect(userStake).to.be.gt(0)
        })
    })
})