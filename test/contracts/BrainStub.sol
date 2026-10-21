// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Test-only stand-in with the Brain interface from contracts/Brain.sol (no learning). Used only to check the
/// e2e harness itself when contracts/Brain.json is not built yet (E2E_BRAIN_JSON override).
contract BrainStub {
    address public owner;
    address public teacher;
    uint256 public lessons;
    uint256 public examplesSeen;
    int256 public lr = 1229;
    uint256[132] public slots;
    uint256 private seed;

    event Lesson(uint256 indexed n, address indexed by, bytes32 indexed ref, uint256 examples, int256 avgTargetProbQ12, bytes text);

    constructor(uint256 s, address t) { owner = msg.sender; teacher = t; seed = s; }

    function teach(bytes calldata text, address by, bytes32 ref) external {
        require(msg.sender == teacher, "not teacher");
        require(text.length >= 4 && text.length <= 64, "len");
        uint256 ex = text.length - 3;
        for (uint256 i = 0; i < 132; i++) slots[i] = uint256(keccak256(abi.encode(slots[i], text, i)));
        lessons += 1;
        examplesSeen += ex;
        int256 p = int256(128 + (lessons * 7 % 900));
        emit Lesson(lessons, by, ref, ex, p, text);
    }

    function speak(bytes calldata prompt, uint256 n, uint256 s, uint256) external view returns (string memory) {
        require(n <= 200, "n");
        bytes memory out = new bytes(prompt.length + n);
        for (uint256 i = 0; i < prompt.length; i++) out[i] = prompt[i];
        uint256 r = uint256(keccak256(abi.encode(s, seed, lessons)));
        for (uint256 i = 0; i < n; i++) { r = uint256(keccak256(abi.encode(r))); uint8 c = uint8(r % 27); out[prompt.length + i] = c == 0 ? bytes1(" ") : bytes1(96 + c); }
        return string(out);
    }

    function score(bytes calldata) external view returns (int256) { return int256(128 + (lessons * 7 % 900)); }
    function setTeacher(address t) external { require(msg.sender == owner); teacher = t; }
    function setLr(int256 v) external { require(msg.sender == owner && v >= 205 && v <= 4096); lr = v; }
    function transferOwnership(address o) external { require(msg.sender == owner); owner = o; }
}
