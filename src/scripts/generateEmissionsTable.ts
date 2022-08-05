import fs from "fs";
import { ethers } from "ethers";

const provider = ethers.getDefaultProvider();

console.log("👌 You are using the default provider.");
console.log(
  "👌 This should work fine, but you may see an API rate limit warning."
);

let csvToJson = require("convert-csv-to-json");

const ETHERSCAN_API_KEY = "etherscan_api_key";

// Constants
const secondsInDay = 86400;
const kwhPerTerahash = 0.00002;
/** Rough average from https://kylemcdonald.github.io/ethereum-emissions/ */
const emissionsPerKwh = 325;
/**
 * Rough average, not including overhead and efficiency multipliers.
 * https://kylemcdonald.github.io/ethereum-emissions/
 */
const hashEfficiency = 0.4;
export interface GasData {
  "Date(UTC)": string;
  UnixTimeStamp: number;
  Value: string;
}

export interface HashrateData {
  "Date(UTC)": string;
  UnixTimeStamp: number;
  Value: number;
}

export interface blockDataType {
  index: number;
  UNIXTime: number;
  blockNumber: number;
}

export interface emissionDataType {
  UNIXTime: number;
  blockNumber: number;
  emissionFactor: number;
}

export function blockData(
  index: number,
  UNIXTime: number,
  blockNumber: number
) {
  return {
    index,
    UNIXTime,
    blockNumber,
  };
}

function emissionData(
  UNIXTime: number,
  blockNumber: number,
  emissionFactor: number
) {
  return {
    UNIXTime,
    blockNumber,
    emissionFactor,
  };
}

const getJSONData = (filePrefix: "GasUsed" | "NetworkHash") => {
  let inputFileName = "";
  fs.readdirSync("src/data").forEach((p) => {
    if (p.startsWith(filePrefix)) {
      inputFileName = p;
    }
  });
  if (!inputFileName)
    console.error(
      `❌ Could not find src/data/${filePrefix}-[date].csv - did you name the csv file correctly?`
    );
  const json = csvToJson
    .fieldDelimiter(",")
    .getJsonFromCsv("src/data/" + inputFileName);

  // Remove double quotations from output
  return JSON.parse(JSON.stringify(json).replace(/\\"/g, ""));
};

export const arrayifyCSVData = (gas: GasData[]) => {
  // Convert JSON data to array
  const gasUsedArray: GasData[] = [];
  const timestampArray: number[] = [];
  for (let i = 0; i < gas.length; i++) {
    gasUsedArray.push(gas[i]);
    timestampArray.push(gas[i].UnixTimeStamp);
  }
  return [gasUsedArray, timestampArray];
};

export const findClosest = (goal: number, array: any[]) => {
  let closest = array[0];
  let diff = Math.abs(goal - closest);
  for (let i = 0; i < array.length; i++) {
    let newdiff = Math.abs(goal - array[i]);
    if (newdiff < diff) {
      diff = newdiff;
      closest = array[i];
    }
  }
  return closest;
};

/**
 * We have gas used for each day, but we don't know the block numbers.
 * For the given blockResolution, fetch the block data and merge with most recent csv gas record.
 */
export const fetchIndexesFromBlockResolution = async (
  blockResolution: number,
  latestBlock: number,
  gasData: GasData[]
) => {
  console.log("Generating index array using block resolution");

  let indexArray = [];

  for (let i = 0; i < latestBlock; i += blockResolution) {
    const block = await provider.getBlock(i);
    // find first day in gas csv that is older than the given block
    let gasDataIndex = gasData.findIndex((_day, index) => {
      return gasData[index + 1].UnixTimeStamp > block.timestamp; // both are in seconds since epoch
    });
    if (gasDataIndex === -1) {
      // if the block is older than every record in the csv, use the last record
      gasDataIndex = gasData.length - 1;
    }

    indexArray.push(blockData(gasDataIndex, block.timestamp, i));
  }
  // Append final value from JSON
  const finalIndex = gasData.length - 1;
  indexArray.push(
    blockData(finalIndex, gasData[finalIndex].UnixTimeStamp, latestBlock)
  );
  return indexArray;
};

export const fetchIndexesFromDayResolution = async (
  dayResolution: number,
  gas: GasData[]
) => {
  let indexArray = [];
  console.log("Generating index array using day resolution");
  // Loop through gas used data
  for (let i = 0; i < gas.length; i++) {
    // If we are at the start of the day range, push that index data to array
    if (i % dayResolution === 0) {
      // Catch any timestamps before block 1
      let UNIXTimestamp = gas[i].UnixTimeStamp;
      if (UNIXTimestamp < 1438270000) {
        UNIXTimestamp = 1438270000;
      }

      // Find block number from timestamp
      // Construct etherscan URL
      const etherscanURL =
        "https://api.etherscan.io/api?module=block&action=getblocknobytime&timestamp=" +
        UNIXTimestamp +
        "&closest=before&apikey=" +
        ETHERSCAN_API_KEY;

      // Fetch etherscan data
      async function fetchEtherscanData(url: string) {
        const res = await fetch(url);

        if (!res.ok) {
          const json = await res.json();
          throw json;
        }
        const data = await res.json();
        return data;
      }

      let data = await fetchEtherscanData(etherscanURL);

      // Avoid max API call rate
      if (data.status === "0") {
        data = await fetchEtherscanData(etherscanURL);
      }

      // Convert string to int
      const blockNumber = parseInt(data.result);

      // Push index data to array
      indexArray.push(blockData(i, gas[i].UnixTimeStamp, blockNumber));
    }
  }

  // Push final index to array
  const finalIndex = gas.length - 1;
  const finalTimestamp = gas[finalIndex].UnixTimeStamp;

  // Find final block number
  const res = await fetch(
    "https://api.etherscan.io/api?module=block&action=getblocknobytime&timestamp=" +
      finalTimestamp +
      "&closest=before&apikey=" +
      ETHERSCAN_API_KEY
  );
  if (!res.ok) {
    const json = await res.json();
    throw json;
  }
  const data = await res.json();

  const finalBlock = parseInt(data.result);
  indexArray.push(blockData(finalIndex, finalTimestamp, finalBlock));

  return indexArray;
};

const fetchBlockOrDayIndexArray = async (
  blockOrDay: string,
  resolution: number,
  currentBlock: number,
  gasData: GasData[]
) => {
  let result = [];

  // Calculate using day or block range and switch function accordingly
  switch (blockOrDay) {
    case "block":
      result = await fetchIndexesFromBlockResolution(
        resolution,
        currentBlock,
        gasData
      );
      break;
    case "day":
      result = await fetchIndexesFromDayResolution(resolution, gasData);
      break;
    default:
      throw "Please specify 'block' or 'day'";
  }
  return result;
};

export const generateEmissionDataFromIndexArray = async (
  blockOrDay: string,
  blockResolution: number
) => {
  console.log("Generating new emissions data");
  // Getch gas and network hashrate data
  const gasData = getJSONData("GasUsed");
  const hashrateData = getJSONData("NetworkHash");
  // Use Web3 to get the number of the most recently mined block
  const currentBlock = await provider.getBlockNumber();

  // Fetch index data for specified data resolution
  const indexArray = await fetchBlockOrDayIndexArray(
    blockOrDay,
    blockResolution,
    currentBlock,
    gasData
  );

  let valueArray = new Array();

  let timestampArray = [];
  let blockArray = [];

  // Loop through index data
  for (let i = 0; i < indexArray.length - 1; i++) {
    // Push time and block data to new arrays
    timestampArray.push(indexArray[i].UNIXTime);
    blockArray.push(indexArray[i].blockNumber);

    // Calculate emission factor for each data range
    const emissionFactor = await calculateEmissionFactor(
      indexArray,
      i,
      gasData,
      hashrateData
    );
    const newData = emissionData(
      indexArray[i].UNIXTime,
      indexArray[i].blockNumber,
      emissionFactor
    );
    // Push emission data to array
    valueArray.push(newData);
  }

  // Save data to JSON file
  saveToJSON(valueArray);
};

export const calculateEmissionFactor = async (
  indexArray: any[],
  i: number,
  gasData: GasData[],
  hashrateData: HashrateData[]
) => {
  let cumulativeGasUsed = 0;
  let cumulativeTerahashes = 0;

  // For this data range, add up total gas used and total terahashes
  for (let j = indexArray[i].index; j < indexArray[i + 1].index; j++) {
    cumulativeGasUsed += parseInt(gasData[j].Value, 10);
    cumulativeTerahashes +=
      (hashrateData[j].Value / hashEfficiency) * secondsInDay;
  }

  const dataRangeLength = indexArray[i + 1].index - indexArray[i].index;

  // Calculate emissions per gas for the previous data range
  if (dataRangeLength === 0) {
    return 0;
  } else {
    // Calculate emissions per kg
    const terahashesPerGas =
      cumulativeTerahashes / cumulativeGasUsed / dataRangeLength;
    const emissionsPerTerahash = kwhPerTerahash * emissionsPerKwh;
    const emissionsPerGasKg = emissionsPerTerahash * terahashesPerGas;

    return emissionsPerGasKg;
  }
};

const saveToJSON = (emissionArray: emissionDataType[]) => {
  // Stringify results prior to saving as JSON
  const data = JSON.stringify(emissionArray, undefined, "  ");
  const outputPath = "src/data/emissionFactorTable.json";
  // Save emission data to JSON
  fs.writeFile(outputPath, data, (err) => {
    if (err) {
      throw err;
    }
    console.log(`Saved JSON data to ${outputPath}`);
  });
};

generateEmissionDataFromIndexArray("block", 100000);
// generateEmissionDataFromIndexArray('day', 30)
