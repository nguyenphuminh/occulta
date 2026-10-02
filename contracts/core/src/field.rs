//! BN254 scalar field (the field every value inside a proof lives in), in Montgomery form with
//! four 64-bit limbs. Only what Poseidon needs: addition, multiplication and conversions.

// Montgomery multiplication reads closest to the textbook CIOS algorithm with explicit limb
// indices, and `mul`/`add` are plain field operations rather than operator overloads.
#![allow(clippy::needless_range_loop, clippy::should_implement_trait)]

use alloy_primitives::U256;

/// The scalar field order r, little-endian limbs.
const MODULUS: [u64; 4] = [
    0x43e1f593f0000001,
    0x2833e84879b97091,
    0xb85045b68181585d,
    0x30644e72e131a029,
];
/// -r^-1 mod 2^64.
const INV: u64 = 0xc2e1f593efffffff;
/// 2^512 mod r, used to enter Montgomery form.
const R2: Fr = Fr([
    0x1bb8e645ae216da7,
    0x53fe3ab1e35c59e3,
    0x8c49833d53bb8085,
    0x0216d0b17f4e44a5,
]);

/// The scalar field order as a number.
pub const SCALAR_MODULUS: U256 = U256::from_limbs(MODULUS);

/// A field element in Montgomery form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fr(pub [u64; 4]);

#[inline(always)]
fn mac(acc: u64, a: u64, b: u64, carry: u64) -> (u64, u64) {
    let t = acc as u128 + (a as u128) * (b as u128) + carry as u128;
    (t as u64, (t >> 64) as u64)
}

#[inline(always)]
fn geq_modulus(x: &[u64; 4]) -> bool {
    for i in (0..4).rev() {
        if x[i] != MODULUS[i] {
            return x[i] > MODULUS[i];
        }
    }
    true
}

#[inline(always)]
fn sub_modulus(x: &mut [u64; 4]) {
    let mut borrow = 0u64;
    for i in 0..4 {
        let (d1, b1) = x[i].overflowing_sub(MODULUS[i]);
        let (d2, b2) = d1.overflowing_sub(borrow);
        x[i] = d2;
        borrow = (b1 | b2) as u64;
    }
}

impl Fr {
    pub const ZERO: Fr = Fr([0; 4]);

    /// Montgomery product: a * b * 2^-256 mod r (CIOS).
    pub fn mul(self, rhs: Fr) -> Fr {
        let (a, b) = (self.0, rhs.0);
        let mut t = [0u64; 6];
        for i in 0..4 {
            let mut carry = 0u64;
            for j in 0..4 {
                let (lo, hi) = mac(t[j], a[j], b[i], carry);
                t[j] = lo;
                carry = hi;
            }
            let (s, c) = t[4].overflowing_add(carry);
            t[4] = s;
            t[5] = c as u64;

            let m = t[0].wrapping_mul(INV);
            let (_, mut carry) = mac(t[0], m, MODULUS[0], 0);
            for j in 1..4 {
                let (lo, hi) = mac(t[j], m, MODULUS[j], carry);
                t[j - 1] = lo;
                carry = hi;
            }
            let (s, c) = t[4].overflowing_add(carry);
            t[3] = s;
            t[4] = t[5] + c as u64;
        }
        let mut out = [t[0], t[1], t[2], t[3]];
        if t[4] != 0 || geq_modulus(&out) {
            sub_modulus(&mut out);
        }
        Fr(out)
    }

    pub fn add(self, rhs: Fr) -> Fr {
        // Both operands are below r < 2^254, so the sum fits in 256 bits.
        let mut out = [0u64; 4];
        let mut carry = 0u64;
        for i in 0..4 {
            let (s1, c1) = self.0[i].overflowing_add(rhs.0[i]);
            let (s2, c2) = s1.overflowing_add(carry);
            out[i] = s2;
            carry = (c1 | c2) as u64;
        }
        if geq_modulus(&out) {
            sub_modulus(&mut out);
        }
        Fr(out)
    }

    pub fn pow5(self) -> Fr {
        let sq = self.mul(self);
        sq.mul(sq).mul(self)
    }

    /// Enters Montgomery form. The caller guarantees `x < r`.
    pub fn from_u256(x: U256) -> Fr {
        debug_assert!(x < SCALAR_MODULUS);
        Fr(*x.as_limbs()).mul(R2)
    }

    pub fn to_u256(self) -> U256 {
        U256::from_limbs(self.mul(Fr([1, 0, 0, 0])).0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fr(x: u64) -> Fr {
        Fr::from_u256(U256::from(x))
    }

    #[test]
    fn round_trips_and_small_arithmetic() {
        for x in [0u64, 1, 2, 12345, u64::MAX] {
            assert_eq!(fr(x).to_u256(), U256::from(x));
        }
        assert_eq!(fr(6).mul(fr(7)).to_u256(), U256::from(42));
        assert_eq!(fr(2).pow5().to_u256(), U256::from(32));
        assert_eq!(fr(40).add(fr(2)).to_u256(), U256::from(42));
    }

    #[test]
    fn wraps_at_the_modulus() {
        let minus_one = Fr::from_u256(SCALAR_MODULUS - U256::from(1));
        assert_eq!(minus_one.add(fr(1)).to_u256(), U256::ZERO);
        assert_eq!(minus_one.mul(minus_one).to_u256(), U256::from(1));
        let half = SCALAR_MODULUS / U256::from(2);
        assert_eq!(
            Fr::from_u256(half).add(Fr::from_u256(half)).to_u256(),
            SCALAR_MODULUS - U256::from(1)
        );
    }

    #[test]
    fn matches_bigint_multiplication() {
        let mut seed = U256::from(0x1234_5678u64);
        for _ in 0..200 {
            seed = seed
                .wrapping_mul(U256::from(6364136223846793005u64))
                .wrapping_add(U256::from(1442695040888963407u64));
            let a = seed % SCALAR_MODULUS;
            let b = (seed >> 7) % SCALAR_MODULUS;
            let expect = a.mul_mod(b, SCALAR_MODULUS);
            assert_eq!(Fr::from_u256(a).mul(Fr::from_u256(b)).to_u256(), expect);
            assert_eq!(
                Fr::from_u256(a).add(Fr::from_u256(b)).to_u256(),
                a.add_mod(b, SCALAR_MODULUS)
            );
        }
    }
}
