package security

import "testing"

func TestNormalizeRelative(t *testing.T) {
	cases := []struct{ input string; valid bool }{
		{"server.properties", true}, {"config/paper.yml", true}, {"../secret.yml", false},
		{"/etc/passwd", false}, {"C:\\Windows\\secret.conf", false}, {"world/level.dat", false},
	}
	for _, tc := range cases {
		_, err := NormalizeRelative(tc.input)
		if (err == nil) != tc.valid { t.Fatalf("%q validity = %v, error=%v", tc.input, err == nil, err) }
	}
}
