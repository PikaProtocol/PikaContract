// import { ethers } from "hardhat";
// import { expect } from "chai";
const hre = require("hardhat");

describe("pikaperp deploy", function () {
    before(async function () {
      const PikaPerp = await hre.ethers.getContractFactory("PikaPerp");
      const pikaperp = await PikaPerp.deploy();
      await pikaperp.deployed();
      console.log("pikaperp deployed to:", pikaperp.address);
    })


    // it("should have correct burnlong", async function () { 
    //   const name = await this.pikaperp.BurnLong()
    // })


})