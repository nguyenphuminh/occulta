//! Stateless Groth16 verifier for the four Occulta circuits (keys from the circuits' setup).
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::U256;
use occulta_core::groth16;
use stylus_sdk::prelude::*;

#[storage]
#[entrypoint]
pub struct Verifier;

#[public]
impl Verifier {
    /// True when `proof` (EVM order) proves `circuit` (0 transfer, 1 finalize, 2 reclaim,
    /// 3 submit-state) for the public `signals`.
    pub fn verify(&self, circuit: u8, proof: [U256; 8], signals: Vec<U256>) -> bool {
        let Some(vk) = occulta_core::verifying_key(circuit) else {
            return false;
        };
        #[cfg(target_arch = "wasm32")]
        let curve = precompiles::Precompiles(self.vm());
        #[cfg(not(target_arch = "wasm32"))]
        let curve = groth16::Native;
        groth16::verify(&curve, vk, &proof, &signals)
    }
}

/// The BN254 precompiles (0x06 add, 0x07 multiply, 0x08 pairing) on-chain.
#[cfg(target_arch = "wasm32")]
mod precompiles {
    use alloc::vec::Vec;
    use alloy_primitives::{Address, U256};
    use occulta_core::groth16::Curve;
    use stylus_sdk::call::static_call;
    use stylus_sdk::prelude::*;

    const EC_ADD: Address = Address::with_last_byte(0x06);
    const EC_MUL: Address = Address::with_last_byte(0x07);
    const EC_PAIRING: Address = Address::with_last_byte(0x08);

    pub struct Precompiles<'a, H: Host + ?Sized>(pub &'a H);

    impl<H: Host + ?Sized> Precompiles<'_, H> {
        fn call(&self, to: Address, data: &[u8]) -> Option<Vec<u8>> {
            static_call(self.0, Call::new(), to, data).ok()
        }
    }

    impl<H: Host + ?Sized> Curve for Precompiles<'_, H> {
        fn add(&self, a: &[u8; 64], b: &[u8; 64]) -> Option<[u8; 64]> {
            let mut data = [0u8; 128];
            data[..64].copy_from_slice(a);
            data[64..].copy_from_slice(b);
            self.call(EC_ADD, &data)?.try_into().ok()
        }

        fn mul(&self, p: &[u8; 64], scalar: U256) -> Option<[u8; 64]> {
            let mut data = [0u8; 96];
            data[..64].copy_from_slice(p);
            data[64..].copy_from_slice(&scalar.to_be_bytes::<32>());
            self.call(EC_MUL, &data)?.try_into().ok()
        }

        fn pairing_is_one(&self, input: &[u8]) -> Option<bool> {
            let out = self.call(EC_PAIRING, input)?;
            (out.len() == 32).then(|| out[31] == 1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stylus_sdk::testing::TestVM;

    fn fixture(name: &str) -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../circuits/build/fixtures")
            .join(name);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("missing {} (run `npm run setup`)", path.display()));
        serde_json::from_str(&text).unwrap()
    }

    fn words(v: &serde_json::Value) -> Vec<U256> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| U256::from_str_radix(x.as_str().unwrap(), 10).unwrap())
            .collect()
    }

    fn case(v: &serde_json::Value) -> ([U256; 8], Vec<U256>) {
        (words(&v["proof"]).try_into().unwrap(), words(&v["signals"]))
    }

    #[test]
    fn accepts_real_proofs_of_every_circuit() {
        let vm = TestVM::default();
        let verifier = Verifier::from(&vm);
        let (pool, dispute) = (fixture("pool.json"), fixture("dispute.json"));
        for (circuit, v) in [
            (occulta_core::TRANSFER, &pool["transfer"]),
            (occulta_core::TRANSFER, &pool["withdrawal"]),
            (occulta_core::SUBMIT_STATE, &dispute["submitLatest"]),
            (occulta_core::FINALIZE, &dispute["finalize"]),
            (occulta_core::RECLAIM, &dispute["reclaim"]),
        ] {
            let (proof, signals) = case(v);
            assert!(
                verifier.verify(circuit, proof, signals),
                "circuit {circuit}"
            );
        }
    }

    #[test]
    fn rejects_tampered_signals_wrong_circuit_and_malformed_input() {
        let vm = TestVM::default();
        let verifier = Verifier::from(&vm);
        let (proof, signals) = case(&fixture("pool.json")["transfer"]);
        for i in 0..signals.len() {
            let mut tampered = signals.clone();
            tampered[i] += U256::from(1);
            assert!(
                !verifier.verify(occulta_core::TRANSFER, proof, tampered),
                "signal {i}"
            );
        }
        assert!(!verifier.verify(occulta_core::FINALIZE, proof, signals.clone()));
        assert!(!verifier.verify(9, proof, signals.clone()));
        assert!(!verifier.verify(occulta_core::TRANSFER, proof, signals[..8].to_vec()));
        let mut bad = proof;
        bad[0] += U256::from(1);
        assert!(!verifier.verify(occulta_core::TRANSFER, bad, signals.clone()));
        let mut out_of_field = signals;
        out_of_field[0] = occulta_core::SCALAR_MODULUS;
        assert!(!verifier.verify(occulta_core::TRANSFER, proof, out_of_field));
    }
}
