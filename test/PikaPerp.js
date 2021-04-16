// import { ethers } from "hardhat";
// import { expect } from "chai";
const { expect, should } = require("chai");
const hre = require("hardhat");

describe("perpETH deploy", function () {

  before(async function () {

    this.signers = await ethers.getSigners()
    this.alice = this.signers[0]
    this.bob = this.signers[1]
    this.carol = this.signers[2]
    this.dev = this.signers[3]
    this.minter = this.signers[4]

    this.PerpETH = await hre.ethers.getContractFactory("PerpETH");
    this.tokenERC = await hre.ethers.getContractFactory("SimpleERC20");
    this.linkoracle = await hre.ethers.getContractFactory("SimpleOracle");
    this.pikacontract = await hre.ethers.getContractFactory("Pika")

  })

  beforeEach(async function () {
    this.perpETH = await this.PerpETH.deploy();
    this.token = await this.tokenERC.deploy()
    this.oracle = await this.linkoracle.deploy()
    this.pika = await this.pikacontract.deploy(42)
    this.uri = "http://github.com/"
    this.coeff = "104000000000000000000000000000000000000000000000"
    this.reserve = "10000000000000000000000"
    this.liquidationPerSec = "1000000000000000000"
    await this.perpETH.initialize(
      this.uri, this.pika.address, this.token.address, this.oracle.address, this.coeff, this.reserve, this.liquidationPerSec
    )
  })

  it("should call balanceof method", async function () {
    const balance = await this.perpETH.balanceOf(this.alice.address, 0)
    expect(balance)
  })


  describe("call all initialize method", async function(){
    it("should call burden method", async function () {
      const burdenvalue = await this.perpETH.burden()
      expect(burdenvalue).to.equal("0")
    })

    it("should have MintShort and expect 1", async function () {
      const MintShort = await this.perpETH.MintShort()
      expect(MintShort).to.be.equal("2");  
    })

    it("should have MintLong and", async function () {
      const MintLong = await this.perpETH.MintLong()
      expect(MintLong).to.be.equal("0");  
    })

    it("should have minSafeShortSlot method", async function(){
      const slot = await this.perpETH.minSafeShortSlot()
      expect(slot).to.be.equal("18012");  
    })


    it("should have burnlong and expect 1", async function () {
      const burnlong = await this.perpETH.BurnLong()
      expect(burnlong).to.be.equal("1");  
    })

    it("should get value insurance method", async function () {
      const insurance = await this.perpETH.insurance()
      expect(insurance).to.equal('0')
    })

  it("should call poke method", async function () {
    const pokefunction = await this.perpETH.poke()
    expect(pokefunction)
  })


    it("should call short method", async function () {
      const short = await this.perpETH.BurnShort()
      expect(short).to.be.equal("3");
    })

    it("should call coeff method", async function () {
      const coeffvalue = await this.perpETH.coeff()
      expect(coeffvalue).to.equal("104000000000000000000000000000000000000000000000")
    })
    it("should call  commissionOf method", async function () {
      const commissionOf = await this.perpETH.commissionOf(this.dev.address)
      expect(commissionOf).to.equal("0")
    })

    it("should call decayPerSecond method", async function () {
      const perSecond = await this.perpETH.decayPerSecond()
      expect(perSecond).to.equal("998000000000000000")
    })

    it("should call getLatestMark method", async function () {
      const LatestMark = await this.perpETH.getLatestMark()
      expect(LatestMark).to.equal("1040000000000000000000")
    })

    it("should call reserve method", async function(){
      const reserve = await this.perpETH.reserve()
      expect(reserve).to.equal('10000000000000000000000')
    })

    it("should call maxSafeLongSlot method", async function(){
      const safeslot = await this.perpETH.maxSafeLongSlot()
      expect(safeslot).to.equal('17967')
    })


    it("should set value getLeverageFromStrike method", async function () {
      const strike = 100
      const getstrike = await this.perpETH.getLeverageFromStrike(strike)
      expect(getstrike).to.equal(strike)
    })

  })


  describe("call setter and getter method", async function () {

    it("should set setPendingGovernor method", async function () {
      const setGovernor = await this.perpETH.setPendingGovernor(this.bob.address)
      expect(setGovernor)
    })

    it("if sender is not governor ", async function () {
      await expect(this.perpETH.connect(this.bob).setSpotMarkThreshold("100", { from: this.bob.address })).to.be.revertedWith("Only governor can call this function.")
    })

    it("should set value setSpotMarkThreshold method", async function () {
      const newspot = '100000000'
      const spotMark = await this.perpETH.setSpotMarkThreshold(newspot)
      const spotMarkThreshold = await this.perpETH.spotMarkThreshold()
      expect(spotMarkThreshold).to.equal(newspot)
    })


    it("should set value setLiquidationPerSec method", async function () {
      const nextliquidation = "10000000000000000"
      const liquidation = await this.perpETH.setLiquidationPerSec(nextliquidation)
      const liquidationPerSec = await this.perpETH.liquidationPerSec()
      expect(liquidationPerSec).to.equal(nextliquidation)
    })

    it("should set value setTradingFee method", async function () {
      const TradingFee = "1000000"
      const fee = await this.perpETH.setTradingFee(TradingFee)
      const tradingFee = await this.perpETH.tradingFee()
      expect(tradingFee).to.equal(TradingFee)
    })


    it("should set value setFundingAdjustThreshold  and get fundingAdjustThreshold method", async function () {
      const setfunding = "10000000000"
      const funding = await this.perpETH.setFundingAdjustThreshold(setfunding)
      const fundingAdjustThreshold = await this.perpETH.fundingAdjustThreshold()
      expect(fundingAdjustThreshold).to.equal(setfunding)
    })

    it("should set value setSafeThreshold and get safeThreshold method ", async function () {
      const newsafethreshold = "1000000000000"
      const Threshold = await this.perpETH.setSafeThreshold(newsafethreshold)
      const safe = await this.perpETH.safeThreshold()
      expect(safe).to.be.equal(newsafethreshold)
    })

    it("should set value  setDecayPerSecond and get decayPerSecond  method", async function () {
      const newdecay = '10000000000'
      const PerSecond = await this.perpETH.setDecayPerSecond(newdecay)
      const decayPerSecond = await this.perpETH.decayPerSecond()
      expect(decayPerSecond).to.equal(newdecay)
    })

    it("should set value setMaxShiftChangePerSecond and get maxShiftChangePerSecond method", async function () {
      const maxshift = 100000000
      const maxpersecond = await this.perpETH.setMaxShiftChangePerSecond(maxshift)
      const maxShiftChangePerSecond = await this.perpETH.maxShiftChangePerSecond()
      expect(maxShiftChangePerSecond).to.equal(maxshift)
    })


    it("should set value setMaxPokeElapsed and get maxPokeElapsed method", async function () {
      const maxpoke = '100000000'
      const setnewvalue = await this.perpETH.setMaxPokeElapsed(maxpoke)
      const maxPokeElapsed = await this.perpETH.maxPokeElapsed()
      expect(maxPokeElapsed).to.equal(maxpoke)
    })

  })


  describe("this describe call for set value method ", async function () {

    it("should set value for setLiquidity method", async function () {
      const nextCoeff = "100000000000"
      const nextReserve0 = '1000000000000'
      const Liquidity = await this.perpETH.setLiquidity(nextCoeff, nextReserve0)
      expect(Liquidity)
    })

    it("should get value getSpotPx method", async function () {
      const getpx = await this.perpETH.getSpotPx()
      expect(getpx)
    })
  })


  describe("call openlong closelong  openShort closeShort method", function () {
    it("should call openlong method", async function () {
      const size = 5
      const strike = 1000000000000000
      const minget = 2
      const referrer = this.pika.address
      const long = await this.perpETH.openLong(size,strike,minget,referrer, {value: 500000000})
      expect(long)
    })

    it("should call closelong method", async function () {
      const size = 5
      const strike = "1000000000000000"
      const maxpay = "100000"
      const referrer = this.pika.address
      const close = await this.perpETH.closeLong(size, strike, maxpay, referrer)
      expect(close).to.be.revertedWith("subtraction overflow")
    })

    it("should call openShort method", async function () {
      const size = 5
      const strike = 1000000000000000
      const maxpay = 10000000000000
      const referrer = this.pika.address
      const close = await this.perpETH.openShort(size, strike, maxpay, referrer, {value: 500000000})
      expect(close)
    })
    it("should call closeShort method", async function () {
      const size = 5
      const strike = "1000000000000000"
      const minget = "1"
      const referrer = this.pika.address
      const close = await this.perpETH.closeShort(size, strike, minget, referrer)
      expect(close).to.be.revertedWith("subtraction overflow")

    })
  })
})