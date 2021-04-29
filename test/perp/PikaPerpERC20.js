const { expect } = require("chai")
const hre = require("hardhat")
const { waffle } = require("hardhat")
const { BigNumber } = require("ethers")

const provider = waffle.provider

// Assert that actual is less than 1/accuracy difference from expected
function assertAlmostEqual(actual, expected, accuracy = 100000) {
  const expectedBN = BigNumber.isBigNumber(expected) ? expected : BigNumber.from(expected)
  const actualBN = BigNumber.isBigNumber(actual) ? actual : BigNumber.from(actual)
  const diffBN = expectedBN.gt(actualBN) ? expectedBN.sub(actualBN) : actualBN.sub(expectedBN)
  if (expectedBN.gt(0)) {
    return expect(
        diffBN).to.lt(expectedBN.div(BigNumber.from(accuracy.toString()))
    )
  }
  return expect(
      diffBN).to.lt(-1 * expectedBN.div(BigNumber.from(accuracy.toString()))
  )
}

function getSlot(strike) {
  if (strike < 100) return strike + 800
  let magnitude = 1
  while (strike >= 1000) {
    magnitude++
    strike /= 10
  }
  return 900 * magnitude + strike - 100
}

describe("PikaPerp", function () {

  before(async function () {
    this.wallets = provider.getWallets()
    this.alice = this.wallets[0]
    this.bob = this.wallets[1]
    this.referrer = this.wallets[2]
    this.rewardDistributor = this.wallets[3]
    this.perp = await hre.ethers.getContractFactory("PikaPerp")
    this.tokenERC = await hre.ethers.getContractFactory("SimpleERC20")
    this.linkOracle = await hre.ethers.getContractFactory("SimpleOracle")
    this.pikaContract = await hre.ethers.getContractFactory("Pika")
  })

  beforeEach(async function () {
    this.pikaPerp = await this.perp.deploy()
    this.token = await this.tokenERC.deploy(18)
    this.oracle = await this.linkOracle.deploy()
    this.pika = await this.pikaContract.deploy(42)
    this.uri = "URI"
    this.coeff = "50000000000000000000000000000000000000000000000" // 5e46, 5e10 * 1e18 * 1e18
    this.reserve = "10000000000000000000000000" // 1e25, 10e7 * 1e18, representing $10m usd
    this.baseReserve = "5000000000000000000000" // 5e21, 5e3 * 1e18, representing 5000 eth
    this.liquidationPerSec = "100000000000000000000"
    await this.oracle.setPrice(500000000000000) // set oracle price to 1/2000
    // Set the token address to the erc20 address.
    await this.pikaPerp.initialize(
        this.uri, this.pika.address, this.token.address, this.oracle.address, this.coeff, this.reserve, this.liquidationPerSec
    )
    this.token.mint(this.alice.address, "10000000000000000000000000")
    this.token.approve(this.pikaPerp.address, "100000000000000000000000000000000000000000000000000")
    await this.pika.grantRole(await this.pika.MINTER_ROLE(), this.pikaPerp.address)
    await this.pika.grantRole(await this.pika.BURNER_ROLE(), this.pikaPerp.address)
    await this.pikaPerp.setRewardDistributor(this.rewardDistributor.address)
  })


  describe("trade functions", function () {
    it("should openLong success", async function () {
      const size = "1000000000000000000000" // 1000 usd
      const minGet = "300000000000000000" // 0.3 token
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true)  // the strike for 5x long is 1667
      const referrer = this.referrer.address
      const initialTokenBalance = await this.token.balanceOf(this.alice.address)
      await this.pikaPerp.openLong(size, strike, minGet, referrer, {from: this.alice.address}) // 1token
      // verify token paid
      const expectedPay = BigNumber.from("600000000000000000")  // 0.6 token , 1/1667 * 1000
      const expectedGet = BigNumber.from("498700129987001299") // 0.498.. token, (5e3 - 5e10 / (1e7 + 1000)) * (1 - TRADING_FEE)
      const expectedGetWithoutFee = BigNumber.from("499950005000000000")
      const expectedTokenPaid = expectedPay.sub(expectedGet)
      const currentTokenBalance = await this.token.balanceOf(this.alice.address)
      const tokenPaid = (initialTokenBalance - currentTokenBalance).toString()
      assertAlmostEqual(tokenPaid, expectedTokenPaid)
      // check leverage token balance
      const ident = await this.pikaPerp.getShortIdent(getSlot(strike))
      const leverageTokenBalance = await this.pikaPerp.balanceOf(this.alice.address, ident)
      expect(leverageTokenBalance).to.equal(size)
      // check protocol token balance
      const protocolBalance = await this.token.balanceOf(this.pikaPerp.address)
      assertAlmostEqual(protocolBalance, expectedTokenPaid)
      // check insurance amount
      assertAlmostEqual(await this.pikaPerp.insurance(), parseInt(expectedGetWithoutFee.sub(expectedGet) * 0.7))
      // check referrer fee
      const commission = parseInt(expectedGetWithoutFee.sub(expectedGet) * 0.1)
      assertAlmostEqual(await this.pikaPerp.commissionOf(this.referrer.address), commission)
      // check pikaReward
      const pikaRewardAmount = await this.pikaPerp.pikaReward()
      assertAlmostEqual(pikaRewardAmount, parseInt(expectedGetWithoutFee.sub(expectedGet) * 0.2))
      // check new spot price
      const newSpot = await this.pikaPerp.getSpotPx()
      assertAlmostEqual(newSpot, 4.99900015E14) // 5e10 / ((1e7 + 1000)*(1e7 + 1000)) = 0.000499900015
      // check new mark price after poke
      provider.send("evm_increaseTime", [60])
      await this.pikaPerp.poke()
      const newMark = await this.pikaPerp.mark()
      assertAlmostEqual(newMark, BigNumber.from("499988683084846"))  // 499988683084846 = 0.998 ^ 60 * 500000000000000 + (1 - 0.998 ^ 60) * 4.99900015E15
      // check reward is transferred to rewardDistributor when the execute function is triggered after an hour
      const initialRewardDistributorBalance = await this.token.balanceOf(this.rewardDistributor.address)
      await this.pikaPerp.distributeReward();
      const currentRewardDistributorBalance = await this.token.balanceOf(this.rewardDistributor.address)
      expect((currentRewardDistributorBalance).sub(initialRewardDistributorBalance)).to.equal(pikaRewardAmount)
      // test increase position size for the same strike
      const additionalSize = "2000000000000000000000" // 2000 usd
      await this.pikaPerp.openLong(additionalSize, strike, minGet, referrer, {from: this.alice.address}) // 1token
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal("3000000000000000000000")
    })

    it("should openLong violate minGet", async function () {
      // openLong
      const size = "1000000000000000000000" // 1000 usd
      const minGet = "499000000000000000" // 0.499 token
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true)  // the strike for 5x long is 1667
      await expect(this.pikaPerp.openLong(size, strike, minGet, this.referrer.address, {
        from: this.alice.address,
      })).to.be.revertedWith("min get constraint violation")
    })

    it("should openLong slippage is too high", async function () {
      // openLong
      const size = "300000000000000000000000" // 300000 usd (around 6% slippage)
      const minGet = "100000000000000000000" // 100 token
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true)  // the strike for 5x long is 1667
      await expect(this.pikaPerp.openLong(size, strike, minGet, this.referrer.address, {
        from: this.alice.address,
        gasPrice: "0"
      })).to.be.revertedWith("slippage is too high")
    })

    it("should closeLong", async function () {
      // openLong
      const size = "1000000000000000000000" // 1000 usd
      const minGet = "300000000000000000" // 0.3 token
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true)  // the strike for 5x long is 1667
      await this.pikaPerp.openLong(size, strike, minGet, this.referrer.address, {
        from: this.alice.address,
        value: "1000000000000000000",
        gasPrice: "0"
      }) // 1token
      const ident = await this.pikaPerp.getShortIdent(getSlot(strike))
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(size)
      expect(await this.pikaPerp.getPosition(this.alice.address, strike, true)).to.equal(size)

      // closeLong
      const initialAliceBalance = await this.token.balanceOf(this.alice.address)
      const initialReserve = await this.pikaPerp.reserve()
      const initialCoeff = await this.pikaPerp.coeff()
      const maxPay = "600000000000000000" // 0.5 token
      await this.pikaPerp.closeLong(size, strike, maxPay, this.referrer.address, {
        from: this.alice.address,
        gasPrice: "0"
      }) // 1token
      // check tokens are burned
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(0)
      const expectedGet = BigNumber.from("600000000000000000")  // 0.6 token = 1/1667 * 1000
      const expectedPay = BigNumber.from("501199880000000000") // 0.50119988 token = (5e10 / (1.0001e7 - 1000) - 5e10 / (1.0001e7)) * (1 + TRADING_FEE)
      const expectedTokenGet = expectedGet.sub(expectedPay)
      const currentAliceBalance = await this.token.balanceOf(this.alice.address)
      assertAlmostEqual(currentAliceBalance.sub(initialAliceBalance), expectedTokenGet)
      // check spot price is the same as the price before the long
      expect(await this.pikaPerp.getSpotPx()).to.equal("500000000000000")
      // check if close more than the position, it will revert
      await expect(this.pikaPerp.closeLong(1, strike, maxPay, this.referrer.address, {
        from: this.alice.address,
        gasPrice: "0"
      })).to.be.revertedWith("SafeMath: subtraction overflow")
    })
  })

  it("should openShort success", async function () {
    const size = "1000000000000000000000" // 1000 usd
    const maxPay = "600000000000000000" // 0.6 token
    const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false)  // the strike for 5x short is 2500
    const referrer = this.referrer.address
    const initialTokenBalance = await this.token.balanceOf(this.alice.address)
    await this.pikaPerp.openShort(size, strike, maxPay, referrer, {from: this.alice.address, }) // 1token
    // verity token paid
    const expectedPay = BigNumber.from("501300130013460100")  // 0.5013001300134601 token = (5e10 / (1e7 - 1000) - 5e3) * (1 + TRADING_FEE)
    const expectedGet = BigNumber.from("400000000000000000") // 0.4 token = 1/2500 * 1000
    const expectedPayWithoutFee = BigNumber.from("500050005000957800") // 0.5000500050009578 token = (5e10 / (1e7 - 1000) - 5e3)
    const expectedTokenPaid = expectedPay.sub(expectedGet)
    const currentTokenBalance = await this.token.balanceOf(this.alice.address)
    const tokenPaid = (initialTokenBalance - currentTokenBalance).toString() // 0.101300130012987400 token
    assertAlmostEqual(tokenPaid, expectedTokenPaid)
    // check leverage token balance
    const ident = await this.pikaPerp.getLongIdent(getSlot(strike))
    const tokenBalance = await this.pikaPerp.balanceOf(this.alice.address, ident)
    expect(tokenBalance).to.equal(size)
    // check protocol token balance
    const protocolBalance = await this.token.balanceOf(this.pikaPerp.address)
    assertAlmostEqual(protocolBalance, expectedTokenPaid)
    // check insurance amount
    assertAlmostEqual(await this.pikaPerp.insurance(), expectedPay.sub(expectedPayWithoutFee) * 0.7)
    // check referrer fee
    const commission = parseInt(expectedPay.sub(expectedPayWithoutFee) * 0.1)
    assertAlmostEqual(await this.pikaPerp.commissionOf(this.referrer.address), commission)
    // check pikaReward
    const pikaRewardAmount = await this.pikaPerp.pikaReward()
    assertAlmostEqual(pikaRewardAmount, parseInt(expectedPay.sub(expectedPayWithoutFee) * 0.2))
    // check new spot price
    const newSpot = await this.pikaPerp.getSpotPx()
    assertAlmostEqual(newSpot, 5.00100015E14) // 5e10 / ((1e7 - 1000)*(1e7 - 1000)) = 0.000500100015
    // check new mark price after poke
    provider.send("evm_increaseTime", [60])
    await this.pikaPerp.poke()
    const newMark = await this.pikaPerp.mark()
    assertAlmostEqual(newMark, BigNumber.from("500011320310737"))  // 500011320310737 = 0.998 ^ 60 * 500000000000000 + (1 - 0.998 ^ 60) * 5.00100015E14
  })

  it("should openShort violate maxPay", async function () {
    const size = "1000000000000000000000" // 1000 usd
    const maxPay = "100000000000000000" // 0.6 token
    const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false)  // the strike for 5x short is 2500
    await expect(this.pikaPerp.openShort(size, strike, maxPay, this.referrer.address, {
      from: this.alice.address,
      value: "1000000000000000",
      gasPrice: "0"
    })).to.be.revertedWith("max pay constraint violation")
  })

  it("should openShort slippage is too high", async function () {
    // openLong
    const size = "300000000000000000000000" // 300000 usd (around 6% slippage)
    const maxPay = "200000000000000000000" // 200 token
    const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false)  // the strike for 5x long is 1667
    await expect(this.pikaPerp.openShort(size, strike, maxPay, this.referrer.address, {
      from: this.alice.address
    })).to.be.revertedWith("slippage is too high")
  })

  it("should closeShort", async function () {
    // openShort
    const size = "1000000000000000000000" // 1000 usd
    const maxPay = "600000000000000000" // 0.6 token
    const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false)  // the strike for 5x long is 1667
    await this.pikaPerp.openShort(size, strike, maxPay, this.referrer.address, {
      from: this.alice.address
    }) // 1token
    const ident = await this.pikaPerp.getLongIdent(getSlot(strike))
    expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(size)
    expect(await this.pikaPerp.getPosition(this.alice.address, strike, false)).to.equal(size)

    // closeShort
    const initialAliceBalance = await this.token.balanceOf(this.alice.address)
    const minGet = "300000000000000000" // 0.3 token
    await this.pikaPerp.closeShort(size, strike, minGet, this.referrer.address, {
      from: this.alice.address,
      gasPrice: "0"
    }) // 1token
    // check tokens are burned
    expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(0)
    expect(await this.pikaPerp.getPosition(this.alice.address, strike, true)).to.equal(0)
    const expectedGet = BigNumber.from("600000000000000000")  // 0.6 token = 1/1667 * 1000
    const expectedPay = BigNumber.from("501199880000000000") // 0.50119988 token = (5e10 / (1.0001e7 - 1000) - 5e10 / (1.0001e7)) * (1 + TRADING_FEE)
    const expectedTokenGet = expectedGet.sub(expectedPay)
    const currentAliceBalance = await this.token.balanceOf(this.alice.address)
    assertAlmostEqual(currentAliceBalance.sub(initialAliceBalance), expectedTokenGet)
    // check spot price is the same as the price before the long
    expect(await this.pikaPerp.getSpotPx()).to.equal("500000000000000")
    // check if close more than the position, it will revert
    await expect(this.pikaPerp.closeLong(1, strike, maxPay, this.referrer.address, {
      from: this.alice.address,
      gasPrice: "0"
    })).to.be.revertedWith("SafeMath: subtraction overflow")
  })

  describe("test execute with aggregated actions", function() {
    it("should execute", async function () {
      // 1. Execute a combination of two MintLongs with different strike
      const size = "1000000000000000000000" // 1000 usd
      const firstLongStrike1 = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true)  // the strike for 5x long is 1667
      const firstLongStrike2 = await this.pikaPerp.getStrikeFromLeverage("3000000000000000000", true)  // the strike for 3x long is 1500
      const firstLongAction1 = 2n | (BigInt(parseInt(getSlot(firstLongStrike1))) << 2n) | (BigInt(size) << 18n)
      const firstLongAction2 = 2n | (BigInt(parseInt(getSlot(firstLongStrike2))) << 2n) | (BigInt(size) << 18n)
      const referrer = this.referrer.address
      const firstinitialTokenBalance = await this.token.balanceOf(this.alice.address)
      await this.pikaPerp.execute([firstLongAction1, firstLongAction2], "1500000000000000000", "0", referrer, {from: this.alice.address, }) // 1token
      // verity token paid
      const firstExpectedPay = BigNumber.from("600000000000000000").add(BigNumber.from("666666666666666667"))  // 1.2666666667 token , 1/1667 * 1000 + 1/1500 * 1000
      const firstExpectedGet = BigNumber.from("997300539900000000") // 0.9973005399 token = (5e10 / (1.0001e7 - 2000) - 5e10 / (1.0001e7)) * (1 + TRADING_FEE)
      const firstExpectedTokenPaid = firstExpectedPay.sub(firstExpectedGet)
      const firstTokenPaid = firstinitialTokenBalance.sub(await this.token.balanceOf(this.alice.address))
      assertAlmostEqual(firstTokenPaid, firstExpectedTokenPaid, 100)
      // check leverage token balance
      const firstLongIdent1 = await this.pikaPerp.getShortIdent(parseInt(getSlot(firstLongStrike1)))
      const firstLongIdent2 = await this.pikaPerp.getShortIdent(parseInt(getSlot(firstLongStrike2)))
      expect(await this.pikaPerp.balanceOf(this.alice.address, firstLongIdent1)).to.equal(size)
      expect(await this.pikaPerp.balanceOf(this.alice.address, firstLongIdent2)).to.equal(size)
      // check protocol token balance
      const protocolBalance = await this.token.balanceOf(this.pikaPerp.address)
      assertAlmostEqual(protocolBalance, firstExpectedTokenPaid, 100)
      // check new spot price equals original price, since long and short amounts are equal.
      const newSpot = await this.pikaPerp.getSpotPx()
      assertAlmostEqual(newSpot, 4.9980006E14) // 5e10 / ((1e7 + 2000)*(1e7 + 2000)) = 0.00049980006
      // 2. Execute a combination of two MintShorts for different strikes, two CloseLongs for previous two strikes
      const secondShortStrike1 = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false)  // the strike for 5x short is 2500
      const secondShortStrike2 = await this.pikaPerp.getStrikeFromLeverage("3000000000000000000", false)  // the strike for 3x short is 3000
      const secondShortAction1 = 0n | (BigInt(parseInt(getSlot(secondShortStrike1))) << 2n) | (BigInt(size) << 18n)
      const secondShortAction2 = 0n | (BigInt(parseInt(getSlot(secondShortStrike2))) << 2n) | (BigInt(size) << 18n)
      const closeLongAction1 = 3n | (BigInt(parseInt(getSlot(firstLongStrike1))) << 2n) | (BigInt(size) << 18n)
      const closeLongAction2 = 3n | (BigInt(parseInt(getSlot(firstLongStrike2))) << 2n) | (BigInt(size) << 18n)
      const secondinitialTokenBalance = await this.token.balanceOf(this.alice.address)
      await this.pikaPerp.execute([secondShortAction1, secondShortAction2, closeLongAction1, closeLongAction2], "2500000000000000000", "0", referrer, {from: this.alice.address, }) // 1token
      // check leverage token balance
      // verity token paid
      const secondExpectedGet = BigNumber.from("1999000000000000000")  // 1.999token , 1/2500 * 1000 + 1/1500 * 1000 + 1/1667 * 1000 + 1/3000 * 1000
      const secondExpectedPay = BigNumber.from("2005000000000000000") // 2.005 token,(5e10 / (1.0002e7 - 4000) - 5e10 / (1.0002e7)) * (1 + TRADING_FEE)
      const secondexpectedTokenPaid = secondExpectedPay.sub(secondExpectedGet)
      const secondtokenPaid = secondinitialTokenBalance.sub(await this.token.balanceOf(this.alice.address))
      assertAlmostEqual(secondtokenPaid, secondexpectedTokenPaid, 1000)
      // verify positions
      const secondShortIdent1 = await this.pikaPerp.getLongIdent(parseInt(getSlot(secondShortStrike1)))
      const secondShortIdent2 = await this.pikaPerp.getLongIdent(parseInt(getSlot(secondShortStrike2)))
      expect(await this.pikaPerp.balanceOf(this.alice.address, secondShortIdent1)).to.equal(size)
      expect(await this.pikaPerp.balanceOf(this.alice.address, secondShortIdent2)).to.equal(size)
      expect(await this.pikaPerp.balanceOf(this.alice.address, firstLongIdent1)).to.equal(0)
      expect(await this.pikaPerp.balanceOf(this.alice.address, firstLongIdent2)).to.equal(0)
      // check protocol token balance
      assertAlmostEqual(await this.token.balanceOf(this.pikaPerp.address), secondexpectedTokenPaid.add(firstExpectedTokenPaid), 100)
    })

    it("should execute fail", async function () {
      // 1. Test the execution of combined MintLong and MintShort is not allowed.
      const size = "1000000000000000000000" // 1000 usd
      const firstLongStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true)  // the strike for 5x long is 1667
      const firstShortStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false)  // the strike for 5x short is 2500
      const firstLongAction = 2n | (BigInt(getSlot(firstLongStrike)) << 2n) | (BigInt(size) << 18n)
      const firstShortAction = 0n | (BigInt(getSlot(firstShortStrike)) << 2n) | (BigInt(size) << 18n)
      const referrer = this.referrer.address
      await expect(this.pikaPerp.execute([firstLongAction, firstShortAction], "600000000000000000", "0", referrer, {from: this.alice.address, })) // 1token
          .to.be.revertedWith("revert no MintLong allowed")

      // 2. Test the execution of combined BurnLong and BurnShort is not allowed.
      // Execute MintLong and MintShort separately, and then execute a combination of CloseLong and CloseShort for the previous strike
      const secondLongStrike = await this.pikaPerp.getStrikeFromLeverage("3000000000000000000", true)  // the strike for 5x long is 1500
      const secondShortStrike = await this.pikaPerp.getStrikeFromLeverage("3000000000000000000", false)  // the strike for 5x short is 3000
      const longAction = 2n | (BigInt(parseInt(getSlot(secondLongStrike))) << 2n) | (BigInt(size) << 18n)
      const shortAction = 0n | (BigInt(parseInt(getSlot(secondShortStrike))) << 2n) | (BigInt(size) << 18n)
      await expect(this.pikaPerp.execute([longAction], "2500000000000000000", "0", referrer, {from: this.alice.address, })) // 1token
      await expect(this.pikaPerp.execute([shortAction], "2500000000000000000", "0", referrer, {from: this.alice.address, })) // 1token
      const closeLongAction = 3n | (BigInt(parseInt(getSlot(secondLongStrike))) << 2n) | (BigInt(size) << 18n)
      const closeShortAction = 1n | (BigInt(parseInt(getSlot(secondShortStrike))) << 2n) | (BigInt(size) << 18n)
      await expect(this.pikaPerp.execute([closeLongAction, closeShortAction], "2500000000000000000", "0", referrer, {from: this.alice.address, })) // 1token
          .to.be.revertedWith("revert no BurnLong allowed")
    })
  })

  describe("test liquidation success", function () {
    it("should openLong liquidation", async function () {
      // openLong
      const longSize = "1000000000000000000000" // 1000 usd
      const minGet = "300000000000000000" // 0.3 token
      const longStrike = await this.pikaPerp.getStrikeFromLeverage("13000000000000000000", true)  // the strike for 13x long is 1857. Max leverage is 0.93/0.07 = 13.28
      const safeThreshold = await this.pikaPerp.safeThreshold()
      const liquidationPrice = longStrike.mul(safeThreshold).div("1000000000000000000") // 1/1997 = "500769230769230"
      await this.pikaPerp.openLong(longSize, longStrike, minGet, this.referrer.address, {
        from: this.alice.address
      }) // 1token
      const slot = parseInt(getSlot(longStrike))
      const ident = await this.pikaPerp.getShortIdent(slot)
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(longSize)
      // test the long position has been liquidated
      const shortSize = "10000000000000000000000" // 10000 usd
      const maxPay = "6000000000000000000" // 6 token
      const shortStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false)  // the strike for 5x short is 2500
      await this.pikaPerp.openShort(shortSize, shortStrike, maxPay, this.referrer.address, {
        from: this.alice.address
      }) // 10token
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.poke()
      const newIdent = await this.pikaPerp.getShortIdent(slot)  // Get new ident for the slot. The old ident has been invalidated by increasing shortOffsetOf(slot)
      const expectedNewIdent = ident | (1 << 16)
      expect(await this.pikaPerp.mark()).to.be.gt(liquidationPrice)
      expect(newIdent).to.be.equal(expectedNewIdent)
      expect(await this.pikaPerp.shortOffsetOf(slot)).to.equal(1)
      expect(await this.pikaPerp.balanceOf(this.alice.address, newIdent)).to.equal(0)
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(longSize)
      expect(await this.pikaPerp.getPosition(this.alice.address, longStrike, true)).to.equal(0)
    })
    // test the protocol's limit on liquidation per second.
    it("should openLong liquidation exceeds liquidation limit", async function () {
      // openLong
      const longSize = "1000000000000000000000" // 1000 usd
      const minGet = "300000000000000000" // 0.3 token
      const longStrike = await this.pikaPerp.getStrikeFromLeverage("13000000000000000000", true)  // the strike for 13x long is 1857. Max leverage is 0.93/0.07 = 13.28
      const safeThreshold = await this.pikaPerp.safeThreshold()
      const liquidationPrice = longStrike.mul(safeThreshold).div("1000000000000000000") // 1/1997 = "500769230769230"
      const liquidationPerSecond = "100000000000000000"
      // Set liquidationPerSecond to a very small number
      const decayPerSecond = await this.pikaPerp.decayPerSecond()
      const maxShiftChangePerSecond = await this.pikaPerp.maxShiftChangePerSecond()
      this.pikaPerp.setParametersPerSec(liquidationPerSecond, decayPerSecond, maxShiftChangePerSecond) // 0.1 usd per second
      await this.pikaPerp.openLong(longSize, longStrike, minGet, this.referrer.address, {
        from: this.alice.address
      }) // 1token
      const slot = parseInt(getSlot(longStrike))
      const ident = await this.pikaPerp.getShortIdent(slot)
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(longSize)
      // test the long position has been liquidated
      const shortSize = "10000000000000000000000" // 10000 usd
      const maxPay = "6000000000000000000" // 6 token
      const shortStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false)  // the strike for 5x short is 2500
      await this.pikaPerp.openShort(shortSize, shortStrike, maxPay, this.referrer.address, {
        from: this.alice.address
      }) // 10token
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.poke()
      const newIdent = await this.pikaPerp.getShortIdent(slot)  // Get new ident for the slot. The old ident has been invalidated by increasing shortOffsetOf(slot)
      const expectedNewIdent = ident | (1 << 16)
      expect(await this.pikaPerp.mark()).to.be.gt(liquidationPrice)
      expect(newIdent).to.be.equal(expectedNewIdent)
      expect(await this.pikaPerp.shortOffsetOf(slot)).to.equal(1)
      expect(await this.pikaPerp.balanceOf(this.alice.address, newIdent)).to.equal(0)
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(longSize)
      expect(await this.pikaPerp.getPosition(this.alice.address, longStrike, true)).to.equal(0)
      // user's position gets fully liquidated, but the protocol gradually close the liquidation limited by the liquidationPerSecond
      // when user's 1000 usd position is liquidated, the protocol has -1000 debt. Because the liquidationPerSecond is 0.1 usd per second,
      // after 1 hour, the protocol can liquidate 360 usd(0.1 * 3600). Therefore, the current debt is -640 usd(360 - 1000)
      expect(parseInt(await this.pikaPerp.burden())).to.equal(parseInt(liquidationPerSecond) * 3600 - longSize)
    })

    it("should openShort liquidation success", async function () {
      // openShort
      const shortSize = "1000000000000000000000" // 1000 usd
      const maxPay = "600000000000000000" // 0.6 token
      const shortStrike = await this.pikaPerp.getStrikeFromLeverage("13000000000000000000", false)  // the strike for 13x short is 2167
      const safeThreshold = await this.pikaPerp.safeThreshold()
      const liquidationPrice = shortStrike.mul("10000000000000000000").div(safeThreshold) // 1/2015 = "496277915632754"
      await this.pikaPerp.openShort(shortSize, shortStrike, maxPay, this.referrer.address, {
        from: this.alice.address
      }) // 1token
      const slot = parseInt(getSlot(shortStrike))
      const ident = await this.pikaPerp.getLongIdent(slot)
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(shortSize)
      expect(await this.pikaPerp.getPosition(this.alice.address, shortStrike, false)).to.equal(shortSize)
      // test the short position is liquidated when the price goes up
      const longSize = "100000000000000000000000" // 100000 usd
      const minGet = "30000000000000000000" // 30 token
      const longStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true)  // the strike for 5x short is 2500
      await this.pikaPerp.openLong(longSize, longStrike, minGet, this.referrer.address, {
        from: this.alice.address
      }) // 100token
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.poke()
      const newIdent = await this.pikaPerp.getLongIdent(slot)  // Get new ident for the slot. The old ident has been invalidated by increasing shortOffsetOf(slot)
      expect(liquidationPrice).to.be.gt(await this.pikaPerp.mark())
      expect(await this.pikaPerp.longOffsetOf(slot)).to.equal(1)
      expect(await this.pikaPerp.balanceOf(this.alice.address, newIdent)).to.equal(0)
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(shortSize)
      expect(await this.pikaPerp.getPosition(this.alice.address, shortStrike, true)).to.equal(0)
    })

    it("should openShort liquidation exceeds liquidation limit", async function () {
      // openShort
      const shortSize = "1000000000000000000000" // 1000 usd
      const maxPay = "600000000000000000" // 0.6 token
      const shortStrike = await this.pikaPerp.getStrikeFromLeverage("13000000000000000000", false)  // the strike for 13x short is 2167
      const safeThreshold = await this.pikaPerp.safeThreshold()
      const liquidationPrice = shortStrike.mul("10000000000000000000").div(safeThreshold) // 1/2015 = "496277915632754"
      const liquidationPerSecond = "100000000000000000"
      // Set liquidationPerSecond to a very small number
      const decayPerSecond = await this.pikaPerp.decayPerSecond()
      const maxShiftChangePerSecond = await this.pikaPerp.maxShiftChangePerSecond()
      this.pikaPerp.setParametersPerSec(liquidationPerSecond, decayPerSecond, maxShiftChangePerSecond) // 0.1 usd per second
      await this.pikaPerp.openShort(shortSize, shortStrike, maxPay, this.referrer.address, {
        from: this.alice.address
      }) // 1token
      const slot = parseInt(getSlot(shortStrike))
      const ident = await this.pikaPerp.getLongIdent(slot)
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(shortSize)
      expect(await this.pikaPerp.getPosition(this.alice.address, shortStrike, false)).to.equal(shortSize)
      // test the short position is liquidated when the price goes up
      const longSize = "100000000000000000000000" // 100000 usd
      const minGet = "30000000000000000000" // 30 token
      const longStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true)  // the strike for 5x short is 2500
      await this.pikaPerp.openLong(longSize, longStrike, minGet, this.referrer.address, {
        from: this.alice.address
      }) // 100token
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.poke()
      const newIdent = await this.pikaPerp.getLongIdent(slot)  // Get new ident for the slot. The old ident has been invalidated by increasing shortOffsetOf(slot)
      expect(liquidationPrice).to.be.gt(await this.pikaPerp.mark())
      expect(await this.pikaPerp.longOffsetOf(slot)).to.equal(1)
      expect(await this.pikaPerp.balanceOf(this.alice.address, newIdent)).to.equal(0)
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(shortSize)
      expect(await this.pikaPerp.getPosition(this.alice.address, shortStrike, true)).to.equal(0)
      // user's position gets fully liquidated, but the protocol gradually close the liquidation limited by the liquidationPerSecond
      // when user's 1000 usd position is liquidated, the protocol has 1000 debt. Because the liquidationPerSecond is 0.1 usd per second,
      // after 1 hour, the protocol can liquidate 360 usd(0.1 * 3600). Therefore, the current debt is 640 usd(1000 - 360)
      expect(parseInt(await this.pikaPerp.burden())).to.equal(shortSize - parseInt(liquidationPerSecond) * 3600 )
    })
  })

  describe("test mint and burn PIKA", function () {
    it("should openShort with 1x leverage mint PIKA", async function () {
      // 1. test mint PIKA
      const size = "1000000000000000000000" // 1000 usd
      const maxPay = "600000000000000000" // 0.6 token
      const strike = await this.pikaPerp.getStrikeFromLeverage("1000000000000000000", false)  // the strike for 1x short is 0
      const initialTokenBalance = await this.token.balanceOf(this.alice.address)
      await this.pikaPerp.openShort(size, strike, maxPay, this.referrer.address, {from: this.alice.address}) // 1token
      // verity token paid
      const expectedPay = BigNumber.from("501300130013460100")  // 0.5013001300134601 token = (5e10 / (1e7 - 1000) - 5e3) * (1 + TRADING_FEE)
      const expectedGet = BigNumber.from("0") // 0.4 token = 0 * 1000
      const expectedTokenPaid = expectedPay.sub(expectedGet)
      const currentTokenBalance = await this.token.balanceOf(this.alice.address)
      const tokenPaid = (initialTokenBalance - currentTokenBalance).toString() // 0.101300130012987400 token
      assertAlmostEqual(tokenPaid, expectedTokenPaid)
      // check leverage token balance
      const ident = await this.pikaPerp.getLongIdent(getSlot(strike))
      const leverageTokenBalance = await this.pikaPerp.balanceOf(this.alice.address, ident)
      // verify no leveraged token is minted
      expect(leverageTokenBalance).to.equal(0)
      const pikaBalance = await this.pika.balanceOf(this.alice.address)
      expect(pikaBalance).to.equal(size)

      // 2. test burn pika
      const minGet = "300000000000000000" // 0.3 token
      await this.pikaPerp.closeShort(size, strike, minGet, this.referrer.address, {from: this.alice.address}) // 1token
      expect(await this.pika.balanceOf(this.alice.address)).to.equal(0)
    })
  })

  describe("test set liquidity dynamically by open interest", function () {
    it("should setLiquidity dynamically when open interest increase and decrease", async function () {
      const safeThreshold = await this.pikaPerp.safeThreshold()
      const newSpotMarkThreshold = await this.pikaPerp.spotMarkThreshold()
      const newOIChangeThreshold = await this.pikaPerp.OIChangeThreshold()
      const newVolumeChangeThreshold = await this.pikaPerp.volumeChangeThreshold()
      // set threshold to a large number, to remove the funding effect while testing dynamic liquidity
      await this.pikaPerp.setThresholds("1250000000000000000", safeThreshold, newSpotMarkThreshold, newOIChangeThreshold, newVolumeChangeThreshold)
      await this.pikaPerp.setDynamicLiquidity(true, false)
      // 1. Test liquidity is dynamically increased when open interest increases.
      const size = "100000000000000000000000" // 100000 usd
      const minGet = "30000000000000000000" // 30 token
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true)  // the strike for 5x long is 1667
      const referrer = this.referrer.address
      await this.pikaPerp.openLong(size, strike, minGet, referrer, {
        from: this.alice.address,
        gasPrice: "0"
      }) // 100token
      const liquidityChangePerSec = await this.pikaPerp.liquidityChangePerSec()
      const spot = await this.pikaPerp.getSpotPx()
      const coeff = await this.pikaPerp.coeff()
      const totalOI = await this.pikaPerp.totalOI()
      const smallDecayTwapOI = await this.pikaPerp.smallDecayTwapOI()
      const largeDecayTwapOI = await this.pikaPerp.largeDecayTwapOI()
      expect(smallDecayTwapOI).to.be.equal(largeDecayTwapOI)
      expect(totalOI).to.be.equal("100000000000000000000000")
      assertAlmostEqual(spot, 4.901480247E14) // 5e10 / ((1e7 + 100000)*(1e7 + 100000)) = 0.0004901480247
      // await provider.send("evm_increaseTime", [7200])
      await this.pikaPerp.openLong(size, strike, minGet, referrer, {
        from: this.alice.address,
        gasPrice: "0"
      }) // 100token
      await provider.send("evm_increaseTime", [7200])
      await this.pikaPerp.poke()
      const nextSpot = await this.pikaPerp.getSpotPx()
      const nextCoeff = await this.pikaPerp.coeff()
      const expectedSpot1 = 4.805843906E14  // 5e10 / ((1e7 + 200000)*(1e7 + 200000)) = 0.0004805843906
      const expectedCoeffChange1 = liquidityChangePerSec.mul(coeff).mul(7200).div("1000000000000000000")
      assertAlmostEqual(nextSpot, expectedSpot1)
      assertAlmostEqual(nextCoeff.sub(coeff), expectedCoeffChange1, 100)
      expect(await this.pikaPerp.totalOI()).to.be.equal("200000000000000000000000")
      expect(await this.pikaPerp.largeDecayTwapOI()).to.be.lt(await this.pikaPerp.smallDecayTwapOI())

      // 2. Test liquidity is dynamically decreased when open interest decreases.
      const maxPay = "150000000000000000000" // 30 token
      const closeSize = "200000000000000000000000" // 100000 usd
      const expectedSpot2 =  4.999916662E14 // 5.0041695601851585e10 / ((1.0204252065111530195326154e7 - 200000)*(1.0204252065111530195326154e7 - 200000)) = 0.0004999916662
      const expectedCoeffChange2 = liquidityChangePerSec.mul(nextCoeff).mul(18000).div("1000000000000000000")
      await this.pikaPerp.closeLong(closeSize, strike, maxPay, referrer, {
        from: this.alice.address,
        gasPrice: "0"
      })
      await provider.send("evm_increaseTime", [18000]) // 5 hours
      await this.pikaPerp.poke()
      assertAlmostEqual(await this.pikaPerp.getSpotPx(), expectedSpot2)
      assertAlmostEqual(nextCoeff.sub(await this.pikaPerp.coeff()), expectedCoeffChange2, 100)
      expect(await this.pikaPerp.totalOI()).to.be.equal("0")
      expect(await this.pikaPerp.largeDecayTwapOI()).to.be.gt(await this.pikaPerp.smallDecayTwapOI())
    })
  })

  describe("test set liquidity dynamically by trading volume", function () {
    it("should setLiquidity dynamically when trading volume increases and decreases", async function () {
      const safeThreshold = await this.pikaPerp.safeThreshold()
      const newSpotMarkThreshold = await this.pikaPerp.spotMarkThreshold()
      const newOIChangeThreshold = await this.pikaPerp.OIChangeThreshold()
      const newVolumeChangeThreshold = await this.pikaPerp.volumeChangeThreshold()
      // set threshold to a large number, to remove the funding effect while testing dynamic liquidity
      await this.pikaPerp.setThresholds("1250000000000000000", safeThreshold, newSpotMarkThreshold, newOIChangeThreshold, newVolumeChangeThreshold)
      await this.pikaPerp.setDynamicLiquidity(false, true)
      // 1. Test liquidity is dynamically increased when trading volume increases.
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true)  // the strike for 5x long is 1667
      const referrer = this.referrer.address
      await this.pikaPerp.openLong("100000000000000000000000", strike, "30000000000000000000" , referrer, {
        from: this.alice.address,
      }) // 100token
      const liquidityChangePerSec = await this.pikaPerp.liquidityChangePerSec()
      const spot = await this.pikaPerp.getSpotPx()
      const coeff = await this.pikaPerp.coeff()
      const dailyVolume = await this.pikaPerp.dailyVolume()
      expect(dailyVolume).to.be.equal("100000000000000000000000")
      assertAlmostEqual(spot, 4.901480247E14) // 5e10 / ((1e7 + 100000)*(1e7 + 100000)) = 0.0004901480247
      await provider.send("evm_increaseTime", [86401])
      await this.pikaPerp.openLong("200000000000000000000000", strike, "60000000000000000000", referrer, {
        from: this.alice.address,
        gasPrice: "0"
      }) // 100token
      // await this.pikaPerp.poke()
      expect(await this.pikaPerp.dailyVolume()).to.be.equal("200000000000000000000000")
      expect(await this.pikaPerp.prevDailyVolume()).to.be.equal("100000000000000000000000")
      const nextSpot = await this.pikaPerp.getSpotPx()
      const expectedSpot1 = 4.712979546E14  // 5e10 / ((1e7 + 300000)*(1e7 + 300000)) = 0.0004712979546
      assertAlmostEqual(nextSpot, expectedSpot1)
      await provider.send("evm_increaseTime", [86401])
      await this.pikaPerp.poke()

      const nextCoeff = await this.pikaPerp.coeff()
      const expectedCoeffChange1 = liquidityChangePerSec.mul(coeff).mul(86401).div("1000000000000000000")
      assertAlmostEqual(nextSpot, expectedSpot1)
      assertAlmostEqual(nextCoeff.sub(coeff), expectedCoeffChange1, 1000)
      expect(await this.pikaPerp.dailyVolume()).to.be.equal("0")
      expect(await this.pikaPerp.prevDailyVolume()).to.be.equal("200000000000000000000000")

      // 2. Test liquidity is dynamically decreased when open trading volume decreases.
      const maxPay = "150000000000000000000" // 30 token
      const closeSize = "100000000000000000000000" // 100000 usd
      await this.pikaPerp.closeLong(closeSize, strike, maxPay, referrer, {
        from: this.alice.address,
        gasPrice: "0"
      })
      await provider.send("evm_increaseTime", [86401]) // 24 hours
      await this.pikaPerp.poke()
      const expectedSpot2 =  4.805376273E14 // 5.0500011574070874e10 / ((1.0351373075967440046335431e7 - 100000)*(1.0351373075967440046335431e7 - 100000)) = 0.0004805376273
      const expectedCoeffChange2 = liquidityChangePerSec.mul(nextCoeff).mul(86401).div("1000000000000000000")
      assertAlmostEqual(await this.pikaPerp.getSpotPx(), expectedSpot2, 10000)
      assertAlmostEqual(nextCoeff.sub(await this.pikaPerp.coeff()), expectedCoeffChange2, 1000)
      expect(await this.pikaPerp.dailyVolume()).to.be.equal("0")
      expect(await this.pikaPerp.prevDailyVolume()).to.be.equal("100000000000000000000000")
    })
  })

})
