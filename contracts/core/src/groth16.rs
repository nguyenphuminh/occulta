//! Groth16 verification over BN254: e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1.
//! Points use the EVM precompile encodings (G1 = x || y, G2 = x_c1 || x_c0 || y_c1 || y_c0).

use crate::field::SCALAR_MODULUS;
use alloc::vec::Vec;
use alloy_primitives::U256;

/// The base field order q, which bounds every proof coordinate.
const BASE_MODULUS: U256 = U256::from_limbs([
    0x3c208c16d87cfd47,
    0x97816a916871ca8d,
    0xb85045b68181585d,
    0x30644e72e131a029,
]);

pub struct VerifyingKey {
    pub alpha: [u8; 64],
    pub beta: [u8; 128],
    pub gamma: [u8; 128],
    pub delta: [u8; 128],
    pub ic: &'static [[u8; 64]],
}

/// The curve operations the verifier needs: the EVM precompiles on-chain, a native library in tests.
pub trait Curve {
    fn add(&self, a: &[u8; 64], b: &[u8; 64]) -> Option<[u8; 64]>;
    fn mul(&self, p: &[u8; 64], scalar: U256) -> Option<[u8; 64]>;
    fn pairing_is_one(&self, input: &[u8]) -> Option<bool>;
}

/// `proof` is [A.x, A.y, B.x_c1, B.x_c0, B.y_c1, B.y_c0, C.x, C.y].
pub fn verify(curve: &impl Curve, vk: &VerifyingKey, proof: &[U256; 8], public: &[U256]) -> bool {
    if public.len() + 1 != vk.ic.len() || proof.iter().any(|x| *x >= BASE_MODULUS) {
        return false;
    }
    let mut acc = vk.ic[0];
    for (i, signal) in public.iter().enumerate() {
        if *signal >= SCALAR_MODULUS {
            return false;
        }
        let Some(term) = curve.mul(&vk.ic[i + 1], *signal) else {
            return false;
        };
        let Some(sum) = curve.add(&acc, &term) else {
            return false;
        };
        acc = sum;
    }
    let neg_ay = if proof[1].is_zero() {
        proof[1]
    } else {
        BASE_MODULUS - proof[1]
    };

    let mut input = Vec::with_capacity(768);
    input.extend_from_slice(&proof[0].to_be_bytes::<32>());
    input.extend_from_slice(&neg_ay.to_be_bytes::<32>());
    for word in &proof[2..6] {
        input.extend_from_slice(&word.to_be_bytes::<32>());
    }
    input.extend_from_slice(&vk.alpha);
    input.extend_from_slice(&vk.beta);
    input.extend_from_slice(&acc);
    input.extend_from_slice(&vk.gamma);
    input.extend_from_slice(&proof[6].to_be_bytes::<32>());
    input.extend_from_slice(&proof[7].to_be_bytes::<32>());
    input.extend_from_slice(&vk.delta);
    curve.pairing_is_one(&input).unwrap_or(false)
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::Native;

/// Off-chain implementation of the same three operations, so host tests verify real proofs.
#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::Curve;
    use alloy_primitives::U256;
    use bn::{pairing_batch, AffineG1, AffineG2, Fq, Fq2, Fr, Group, Gt, G1, G2};

    pub struct Native;

    fn fq(bytes: &[u8]) -> Option<Fq> {
        Fq::from_slice(bytes).ok()
    }

    fn g1(bytes: &[u8]) -> Option<G1> {
        let (x, y) = (fq(&bytes[..32])?, fq(&bytes[32..64])?);
        if x.is_zero() && y.is_zero() {
            return Some(G1::zero());
        }
        AffineG1::new(x, y).ok().map(Into::into)
    }

    fn g2(bytes: &[u8]) -> Option<G2> {
        let x = Fq2::new(fq(&bytes[32..64])?, fq(&bytes[..32])?);
        let y = Fq2::new(fq(&bytes[96..128])?, fq(&bytes[64..96])?);
        if x.is_zero() && y.is_zero() {
            return Some(G2::zero());
        }
        AffineG2::new(x, y).ok().map(Into::into)
    }

    fn encode(p: G1) -> [u8; 64] {
        let mut out = [0u8; 64];
        if let Some(a) = AffineG1::from_jacobian(p) {
            a.x().to_big_endian(&mut out[..32]).expect("32 bytes");
            a.y().to_big_endian(&mut out[32..]).expect("32 bytes");
        }
        out
    }

    impl Curve for Native {
        fn add(&self, a: &[u8; 64], b: &[u8; 64]) -> Option<[u8; 64]> {
            Some(encode(g1(a)? + g1(b)?))
        }

        fn mul(&self, p: &[u8; 64], scalar: U256) -> Option<[u8; 64]> {
            let s = Fr::from_slice(&scalar.to_be_bytes::<32>()).ok()?;
            Some(encode(g1(p)? * s))
        }

        fn pairing_is_one(&self, input: &[u8]) -> Option<bool> {
            if !input.len().is_multiple_of(192) {
                return None;
            }
            let mut pairs = alloc::vec::Vec::new();
            for chunk in input.chunks(192) {
                pairs.push((g1(&chunk[..64])?, g2(&chunk[64..])?));
            }
            Some(pairing_batch(&pairs) == Gt::one())
        }
    }
}
